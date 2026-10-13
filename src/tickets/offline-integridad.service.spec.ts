import { webcrypto } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CajasService } from '../cajas/cajas.service';
import { TicketsService } from './tickets.service';
import { OfflineService } from './offline.service';

const EJECUTOR = { id: 3, email: 'taquilla@test.com' };
const SERIE = 'D03';
const ANIO = new Date().getFullYear();
const folioDe = (n: number) =>
  `TCK-${SERIE}-${ANIO}-${String(n).padStart(6, '0')}`;

async function crearTaquilla() {
  const par = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = await webcrypto.subtle.exportKey('spki', par.publicKey);
  const firmar = async (t: string) =>
    Buffer.from(
      await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        par.privateKey,
        new TextEncoder().encode(t),
      ),
    ).toString('base64');
  return {
    firmar,
    registro: {
      id: 7,
      idDispositivo: 'disp-03',
      serie: SERIE,
      llavePublica: Buffer.from(spki).toString('base64'),
      revocado: false,
      ultimoCorrelativo: 0,
      fechaCreacion: new Date(Date.now() - 86400000),
    },
  };
}

/**
 * Integridad de la subida de la cola sin conexión.
 *
 * Lo que se comprueba es qué pasa cuando algo falla a mitad de camino: si una venta
 * mala se lleva a las buenas, si un ticket puede quedar a medio crear, y si
 * reintentar cobra dos veces.
 */
describe('OfflineService · integridad al sincronizar', () => {
  let service: OfflineService;
  let prisma: any;
  let taquilla: Awaited<ReturnType<typeof crearTaquilla>>;
  const apertura = {
    id: 12,
    anulado: false,
    estado: { nombre: 'Abierta' },
    fechaCreacion: new Date(Date.now() - 4 * 3600 * 1000),
  };

  const venta = async (n: number, extra: any = {}) => ({
    idLocal: `local-${n}`,
    numeroTicket: folioDe(n),
    firma: await taquilla.firmar(folioDe(n)),
    fechaEmision: new Date().toISOString(),
    montoCobrado: '20.00',
    ...extra,
  });

  beforeEach(async () => {
    taquilla = await crearTaquilla();
    prisma = {
      $transaction: jest.fn((cb: any) => cb(prisma)),
      ticket: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      dispositivoTaquilla: {
        findUnique: jest.fn().mockResolvedValue(taquilla.registro),
        update: jest.fn(),
      },
      aperturaCaja: { findUnique: jest.fn().mockResolvedValue(apertura) },
      loteOffline: { findUnique: jest.fn().mockResolvedValue(null) },
      usuario: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 3, nombre: 'Taquillero' }),
      },
    };

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        OfflineService,
        { provide: PrismaService, useValue: prisma },
        { provide: CajasService, useValue: {} },
        { provide: TicketsService, useValue: {} },
      ],
    }).compile();
    service = modulo.get<OfflineService>(OfflineService);
  });

  afterEach(() => jest.restoreAllMocks());

  const subir = (ventas: any[]) =>
    service.emitirOffline(
      { dispositivo: 'disp-03', idAperturaCaja: 12, ventas },
      EJECUTOR,
    );

  /**
   * NO hay rollback global, y es deliberado: una venta con datos malos no puede
   * tumbar a las otras, porque cada una es dinero ya cobrado que tiene que entrar.
   */
  it('una venta rechazada no arrastra a las demás', async () => {
    const buena1 = await venta(1);
    const mala = await venta(2, { numeroTicket: 'TCK-D09-2026-000001' }); // serie ajena
    const buena2 = await venta(3);

    (service as any).ticketsService = {
      prepararEmision: jest
        .fn()
        .mockRejectedValue(new Error('catálogo fuera de alcance')),
    };

    const res = await subir([buena1, mala, buena2]);

    expect(res.resultados).toHaveLength(3);
    expect(res.resultados[1]).toMatchObject({
      idLocal: 'local-2',
      estado: 'RECHAZADO',
      codigo: 'FOLIO_DE_OTRA_SERIE',
    });
    // Las otras dos llegaron a procesarse: no quedaron sin intentar.
    expect(res.resultados[0].idLocal).toBe('local-1');
    expect(res.resultados[2].idLocal).toBe('local-3');
    expect(res.resultados[0].codigo).not.toBe('FOLIO_DE_OTRA_SERIE');
  });

  /**
   * SÍ hay rollback dentro de cada venta: la transacción es Serializable, así que un
   * fallo a mitad no deja el ticket del visitante creado sin el del guía, ni el folio
   * consumido sin venta que lo respalde.
   */
  it('cada venta va en su propia transacción, no en una compartida', async () => {
    (service as any).ticketsService = {
      prepararEmision: jest.fn().mockRejectedValue(new Error('corta acá')),
    };

    await subir([await venta(1), await venta(2)]);

    // Dos ventas, dos transacciones: si compartieran una, la primera en fallar
    // abortaría el trabajo de la otra.
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('el fallo del segundo folio de una venta con guía cancela la venta entera', async () => {
    const conGuia = await venta(1, {
      numeroTicketGuia: 'TCK-D09-2026-000002', // serie ajena: revienta el segundo folio
      firmaGuia: await taquilla.firmar('TCK-D09-2026-000002'),
    });

    const res = await subir([conGuia]);

    expect(res.resultados[0]).toMatchObject({ estado: 'RECHAZADO' });
    // Nada se dio por creado: no hay un ticket de visitante huérfano.
    expect(res.procesadas).toBe(0);
  });

  /**
   * El caso que importa cuando se corta la conexión a mitad de la subida: algunas
   * ventas quedaron guardadas y el dispositivo no lo sabe, así que reintenta todo.
   */
  it('reintentar una venta ya guardada no la cobra dos veces', async () => {
    prisma.ticket.findFirst.mockResolvedValue({ id: 55 });
    (service as any).ticketsService = {
      findOne: jest.fn().mockResolvedValue({ id: 55 }),
    };

    const res = await subir([await venta(1)]);

    expect(res.resultados[0]).toMatchObject({ estado: 'DUPLICADO_IGNORADO' });
    expect(res.procesadas).toBe(0);
  });

  it('la respuesta identifica cada venta por su idLocal, para saber qué reintentar', async () => {
    (service as any).ticketsService = {
      prepararEmision: jest.fn().mockRejectedValue(new Error('corta acá')),
    };

    const res = await subir([await venta(1), await venta(2), await venta(3)]);

    expect(res.resultados.map((r: any) => r.idLocal)).toEqual([
      'local-1',
      'local-2',
      'local-3',
    ]);
  });
});
