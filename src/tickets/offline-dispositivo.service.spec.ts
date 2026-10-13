import { webcrypto } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CajasService } from '../cajas/cajas.service';
import { TicketsService } from './tickets.service';
import { OfflineService } from './offline.service';
import { anioDeNegocio, getFechaUTC6 } from '../common/utils/date.util';

const EJECUTOR = { id: 3, email: 'taquilla@test.com' };
const SERIE = 'D03';
// El año del folio es el de Guatemala: `getFullYear()` discrepa durante las
// primeras seis horas de cada 1 de enero si el servidor corre en UTC.
const FOLIO = `TCK-${SERIE}-${anioDeNegocio()}-000123`;

/** Una taquilla de verdad: llave ECDSA P-256 y firma hecha con WebCrypto. */
async function crearTaquilla(extra: any = {}) {
  const par = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = await webcrypto.subtle.exportKey('spki', par.publicKey);

  const firmar = async (texto: string) =>
    Buffer.from(
      await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        par.privateKey,
        new TextEncoder().encode(texto),
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
      fechaCreacion: new Date('2026-01-01T00:00:00.000Z'),
      ...extra,
    },
  };
}

describe('OfflineService · emisión firmada por la taquilla', () => {
  let service: OfflineService;
  let prisma: any;
  let taquilla: Awaited<ReturnType<typeof crearTaquilla>>;

  // Relativa al reloj y no fija: con una hora fija, el mismo caso queda «dentro del
  // turno» o «en el futuro» según a qué hora del día corra la suite.
  const APERTURA = new Date(Date.now() - 4 * 60 * 60 * 1000);

  /**
   * La caja como la devuelve la base, con su `fechaCreacion` en **reloj de pared**.
   *
   * Armarla con el instante real haría pasar una prueba que en producción falla: el
   * piso del acotado sale de esta columna y la fecha de la venta sale del reloj del
   * dispositivo, así que si el dato de prueba no distingue las dos convenciones, la
   * prueba tampoco puede detectar que el código las confunda.
   */
  const cajaAbierta = {
    id: 12,
    anulado: false,
    estado: { nombre: 'Abierta' },
    fechaCreacion: getFechaUTC6(APERTURA),
  };

  const ventaBase = async (extra: any = {}) => ({
    idLocal: 'local-1',
    numeroTicket: FOLIO,
    firma: await taquilla.firmar(FOLIO),
    fechaEmision: '2026-09-16T10:00:00.000Z',
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
      aperturaCaja: { findUnique: jest.fn().mockResolvedValue(cajaAbierta) },
      loteOffline: { findUnique: jest.fn().mockResolvedValue(null) },
      // La declaración de descartes resuelve el nombre del ejecutor para la bitácora.
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

  const subir = (extra: any = {}, ventas: any[] = []) =>
    service.emitirOffline(
      { dispositivo: 'disp-03', idAperturaCaja: 12, ventas, ...extra },
      EJECUTOR,
    );

  describe('elección de modo', () => {
    // Los dos modos asignan la venta a cajas distintas; aceptar ambos dejaría en
    // manos del cliente a qué arqueo entra el dinero.
    it('rechaza enviar lote y dispositivo a la vez', async () => {
      await expect(subir({ idLote: 4 })).rejects.toThrow(BadRequestException);
    });

    it('rechaza no enviar ninguno de los dos', async () => {
      await expect(
        service.emitirOffline({ ventas: [] } as any, EJECUTOR),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('la taquilla tiene que estar habilitada', () => {
    it('rechaza una taquilla que no existe', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue(null);

      await expect(subir()).rejects.toThrow(NotFoundException);
    });

    // Se revoca cuando se pierde el equipo: lo que traiga pendiente lo resuelve un
    // supervisor, no el propio dispositivo subiéndolo como si nada.
    it('rechaza una taquilla revocada', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue({
        ...taquilla.registro,
        revocado: true,
      });

      await expect(subir()).rejects.toThrow(BadRequestException);
    });
  });

  describe('la caja tiene que seguir abierta', () => {
    /**
     * Es la protección que reemplaza al bloqueo por lote.
     *
     * Sin lotes, el servidor ya no sabe que un dispositivo puede deberle ventas, así
     * que nada impide cerrar la caja antes de que suba. Este rechazo es lo que evita
     * que ese dinero entre después a un arqueo ya congelado.
     */
    it('rechaza con CAJA_YA_CERRADA si el arqueo ya se congeló', async () => {
      prisma.aperturaCaja.findUnique.mockResolvedValue({
        ...cajaAbierta,
        estado: { nombre: 'Cerrada' },
      });

      await expect(subir()).rejects.toThrow(ConflictException);
      await expect(subir()).rejects.toMatchObject({
        response: { codigo: 'CAJA_YA_CERRADA', idAperturaCaja: 12 },
      });
    });

    it('rechaza una caja inexistente o anulada', async () => {
      prisma.aperturaCaja.findUnique.mockResolvedValue(null);
      await expect(subir()).rejects.toThrow(NotFoundException);

      prisma.aperturaCaja.findUnique.mockResolvedValue({
        ...cajaAbierta,
        anulado: true,
      });
      await expect(subir()).rejects.toThrow(NotFoundException);
    });

    it('exige que venga la caja: sin ella no se sabe a qué arqueo entra', async () => {
      await expect(subir({ idAperturaCaja: undefined })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('el folio y su firma', () => {
    /** Cada venta se responde por separado: una mala no tumba las demás, que son dinero cobrado. */
    const codigoDe = async (venta: any) =>
      (await subir({}, [venta])).resultados[0];

    it('rechaza un folio de la serie de otra taquilla', async () => {
      const ajeno = 'TCK-D09-2026-000001';
      const res = await codigoDe(
        await ventaBase({
          numeroTicket: ajeno,
          firma: await taquilla.firmar(ajeno),
        }),
      );

      expect(res).toMatchObject({
        estado: 'RECHAZADO',
        codigo: 'FOLIO_DE_OTRA_SERIE',
      });
    });

    it('rechaza una firma que no es de esta taquilla', async () => {
      const otra = await crearTaquilla();
      const res = await codigoDe(
        await ventaBase({ firma: await otra.firmar(FOLIO) }),
      );

      expect(res).toMatchObject({
        estado: 'RECHAZADO',
        codigo: 'FIRMA_INVALIDA',
      });
    });

    it('rechaza una venta sin firma', async () => {
      const res = await codigoDe(await ventaBase({ firma: undefined }));

      expect(res).toMatchObject({
        estado: 'RECHAZADO',
        codigo: 'FIRMA_INVALIDA',
      });
    });

    // Mismo folio en dos ventas: hay dinero cobrado que alguien tiene que revisar.
    it('rechaza un folio que ya respalda otro ticket', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 99,
        numeroTicket: FOLIO,
      });
      const res = await codigoDe(await ventaBase());

      expect(res).toMatchObject({
        estado: 'RECHAZADO',
        codigo: 'FOLIO_YA_EMITIDO',
      });
    });
  });

  /**
   * Una taquilla con llave no debe reservar folios: firma sus propios pases. Y
   * reservarlos no sería inocuo, porque un lote vigente bloquea el cierre de la
   * caja — el taquillero se encontraría con una caja trabada por folios que nadie
   * iba a usar. La guarda vive en el servidor para que un equipo con la aplicación
   * desactualizada tampoco pueda provocarlo.
   */
  describe('una taquilla registrada ya no reserva folios', () => {
    it('rechaza la reserva con DISPOSITIVO_YA_FIRMA', async () => {
      prisma.aperturaCaja = {
        findUnique: jest.fn().mockResolvedValue(cajaAbierta),
      };
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue({
        serie: SERIE,
        revocado: false,
      });
      (service as any).cajasService = {
        obtenerActual: jest.fn().mockResolvedValue({ id: 12 }),
      };

      await expect(
        service.reservar(
          { cantidad: 10, idDispositivo: 'disp-03' } as any,
          EJECUTOR,
        ),
      ).rejects.toMatchObject({
        response: { codigo: 'DISPOSITIVO_YA_FIRMA', serie: SERIE },
      });
    });

    // Una revocada sí puede volver al modelo viejo: es la salida para un equipo
    // al que se le dio de baja la llave y todavía tiene que poder vender.
    it('una taquilla revocada no queda bloqueada por esta guarda', async () => {
      prisma.aperturaCaja = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...cajaAbierta, estado: { nombre: 'Abierta' } }),
      };
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue({
        serie: SERIE,
        revocado: true,
      });
      (service as any).cajasService = {
        obtenerActual: jest.fn().mockResolvedValue({ id: 12 }),
      };

      await expect(
        service.reservar(
          { cantidad: 10, idDispositivo: 'disp-03' } as any,
          EJECUTOR,
        ),
      ).rejects.not.toMatchObject({
        response: { codigo: 'DISPOSITIVO_YA_FIRMA' },
      });
    });
  });

  describe('forma del folio', () => {
    const codigoDe = async (venta: any) =>
      (await subir({}, [venta])).resultados[0];
    const anio = new Date().getFullYear();

    it.each([
      ['TCK-D03-2026-12', 'correlativo corto'],
      ['TCK-D03-26-000123', 'año de dos dígitos'],
      ['TCK-D03-2026-000123-X', 'sobra texto al final'],
      ['PASE-D03-2026-000123', 'prefijo distinto'],
    ])('rechaza %s (%s)', async (folio) => {
      const res = await codigoDe(
        await ventaBase({
          numeroTicket: folio,
          firma: await taquilla.firmar(folio),
        }),
      );

      expect(res).toMatchObject({
        estado: 'RECHAZADO',
        codigo: 'FOLIO_DE_OTRA_SERIE',
      });
    });

    /**
     * El caso que motivó validar el formato entero: la tablet numera con su propio
     * reloj, así que con la fecha mal puesta produce folios de otro año y nadie lo
     * nota hasta que alguien busca esa venta por fecha.
     */
    it('rechaza un folio numerado en un año que no corresponde', async () => {
      const futuro = `TCK-D03-${anio + 1}-000123`;
      const res = await codigoDe(
        await ventaBase({
          numeroTicket: futuro,
          firma: await taquilla.firmar(futuro),
        }),
      );

      expect(res.codigo).toBe('FOLIO_DE_OTRA_SERIE');
    });

    // Una venta del 31 de diciembre subida el 1 de enero es legítima.
    it('acepta el año anterior, por el cruce de fin de año', async () => {
      const previo = `TCK-D03-${anio - 1}-000123`;
      const res = await codigoDe(
        await ventaBase({
          numeroTicket: previo,
          firma: await taquilla.firmar(previo),
        }),
      );

      expect(res.codigo).not.toBe('FOLIO_DE_OTRA_SERIE');
    });

    it('anota el correlativo más alto que llegó de esa taquilla', async () => {
      const folio = `TCK-D03-${anio}-000450`;
      await subir({}, [
        await ventaBase({
          numeroTicket: folio,
          firma: await taquilla.firmar(folio),
        }),
      ]);

      expect(prisma.dispositivoTaquilla.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ultimoCorrelativo: 450 }),
        }),
      );
    });

    it('no retrocede el correlativo con una venta vieja que llega tarde', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue({
        ...taquilla.registro,
        ultimoCorrelativo: 900,
      });
      const folio = `TCK-D03-${anio}-000450`;
      await subir({}, [
        await ventaBase({
          numeroTicket: folio,
          firma: await taquilla.firmar(folio),
        }),
      ]);

      // Sí se actualiza la fila —el folio cuenta como rendido— pero el máximo visto
      // no baja. Son dos contadores con reglas distintas sobre la misma fila.
      const datos = prisma.dispositivoTaquilla.update.mock.calls[0][0].data;
      expect(datos).not.toHaveProperty('ultimoCorrelativo');
      expect(datos.foliosRendidos).toEqual({ increment: 1 });
    });

    /**
     * La resta entre lo numerado y lo rendido es lo que delata un cobro desviado.
     * Por eso el folio cuenta como rendido SIEMPRE que llega, sea o no el más alto:
     * si solo contara al avanzar el máximo, una venta que llega tarde dejaría un
     * hueco permanente y la cifra acusaría a alguien sin motivo.
     */
    it('todo folio que llega cuenta como rendido, avance o no el máximo', async () => {
      const folio = `TCK-D03-${anio}-000450`;
      await subir({}, [
        await ventaBase({
          numeroTicket: folio,
          firma: await taquilla.firmar(folio),
        }),
      ]);

      const datos = prisma.dispositivoTaquilla.update.mock.calls[0][0].data;
      expect(datos.foliosRendidos).toEqual({ increment: 1 });
      expect(datos.ultimoCorrelativo).toBe(450);
    });
  });

  /**
   * Durante la transición una tablet puede tener en la cola ventas de los dos
   * modelos: las viejas con folio reservado y las nuevas firmadas por ella misma.
   * Importa que mezclarlas no arruine el lote entero.
   */
  describe('convivencia de los dos modelos', () => {
    it('una venta de folio reservado enviada en modo dispositivo se rechaza sola', async () => {
      const viejo = 'TCK-2026-000045'; // sin serie de taquilla: es de los reservados
      const res = await subir({}, [
        await ventaBase({
          idLocal: 'vieja',
          numeroTicket: viejo,
          firma: await taquilla.firmar(viejo),
        }),
        await ventaBase({ idLocal: 'nueva' }),
      ]);

      expect(res.resultados[0]).toMatchObject({
        idLocal: 'vieja',
        estado: 'RECHAZADO',
        codigo: 'FOLIO_DE_OTRA_SERIE',
      });
      // La nueva no la arrastra: llega hasta el catálogo, que en este mock no existe.
      expect(res.resultados[1].idLocal).toBe('nueva');
      expect(res.resultados[1].codigo).not.toBe('FOLIO_DE_OTRA_SERIE');
    });
  });

  /**
   * El reloj lo pone el dispositivo, así que la fecha de una venta vale lo que valga
   * el equipo. Lo que la acota es el turno: la venta entra a ESTA caja, luego no
   * puede ser anterior a que se abriera.
   *
   * Importa porque la tarifa se resuelve a la fecha declarada: retrodatar a cuando
   * los precios eran más bajos haría que un cobro menor al real dejara de contar
   * como discrepancia.
   */
  describe('la fecha declarada se acota al turno', () => {
    const fechaUsada = () =>
      (service as any).ticketsService.prepararEmision.mock.calls[0][2];

    beforeEach(() => {
      (service as any).ticketsService = {
        prepararEmision: jest.fn().mockRejectedValue(new Error('corta acá')),
      };
    });

    it('una venta anterior a la apertura se sube al momento de abrir', async () => {
      const mesesAtras = '2026-06-01T10:00:00.000Z';
      await subir({}, [await ventaBase({ fechaEmision: mesesAtras })]);

      expect(fechaUsada()).toEqual(APERTURA);
    });

    it('no usa el alta de la taquilla como piso, que es mucho más atrás', async () => {
      await subir({}, [
        await ventaBase({ fechaEmision: '2026-02-01T10:00:00.000Z' }),
      ]);

      // El registro del dispositivo es de enero; si fuera el piso, pasaría febrero.
      expect(fechaUsada()).toEqual(APERTURA);
      expect(fechaUsada()).not.toEqual(
        new Date(taquilla.registro.fechaCreacion),
      );
    });

    /**
     * La ventana de seis horas donde el acotado fallaba sin que nada avisara.
     *
     * Una fecha de meses atrás la rechaza cualquier versión del código. La que se
     * colaba era esta: dentro del día, pero antes de abrir la caja. El piso venía
     * de la columna sin convertir, o sea seis horas más atrás de lo que debía, y
     * la venta entraba con su fecha intacta para resolver la tarifa de otro día.
     */
    it('una venta de una hora antes de abrir tambien se acota', async () => {
      const unaHoraAntes = new Date(APERTURA.getTime() - 60 * 60 * 1000);
      await subir({}, [
        await ventaBase({ fechaEmision: unaHoraAntes.toISOString() }),
      ]);

      expect(fechaUsada()).toEqual(APERTURA);
      expect(fechaUsada().getTime()).toBeGreaterThan(unaHoraAntes.getTime());
    });

    it('una fecha dentro del turno se respeta tal cual', async () => {
      const durante = new Date(
        APERTURA.getTime() + 60 * 60 * 1000,
      ).toISOString();
      await subir({}, [await ventaBase({ fechaEmision: durante })]);

      expect(fechaUsada()).toEqual(new Date(durante));
    });

    // Un reloj adelantado no puede mandar la venta al futuro.
    it('una fecha futura se recorta al momento de subir', async () => {
      const futuro = new Date(Date.now() + 86400000).toISOString();
      await subir({}, [await ventaBase({ fechaEmision: futuro })]);

      expect(fechaUsada().getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  /**
   * El folio ya dice de qué taquilla salió, así que mandar `dispositivo` aparte es
   * redundante. Que fuera obligatorio costó caro: el sellado del uso lo omitía, el
   * servidor caía a HMAC, el rechazo parecía un pase inválido y se tragaba en
   * silencio el sello de una venta legítima.
   */
  describe('la serie del folio identifica a la taquilla', () => {
    it('el patrón acepta la forma canónica y rechaza las cercanas', () => {
      const patron = /^[^-]+-(D[0-9]{2,})-[0-9]{4}-[0-9]{6}$/;

      expect(patron.exec('TCK-D03-2026-000123')?.[1]).toBe('D03');
      expect(patron.exec('TCK-D120-2026-000123')?.[1]).toBe('D120');
      // Un folio del servidor no lleva serie de taquilla y no debe deducir ninguna.
      expect(patron.exec('TCK-2026-000123')).toBeNull();
      expect(patron.exec('TCK-X03-2026-000123')).toBeNull();
      expect(patron.exec('TCK-D3-2026-000123')).toBeNull();
    });
  });

  /**
   * Descartar un cobro sin conexión es la única operación donde puede desaparecer
   * dinero sin dejar rastro: esa venta nunca llegó al servidor. Declararla no impide
   * el desvío —quien controle el equipo puede callarse— pero le quita el silencio.
   */
  describe('declaración de descartes', () => {
    const declarar = (extra: any = {}, descartes: any[] = []) =>
      service.declararDescartes(
        {
          dispositivo: 'disp-03',
          idAperturaCaja: 12,
          descartes,
          ...extra,
        },
        EJECUTOR,
      );

    const descarteBase = async (extra: any = {}) => ({
      numeroTicket: FOLIO,
      firma: await taquilla.firmar(FOLIO),
      montoCobrado: '40.00',
      fechaDescarte: new Date().toISOString(),
      ...extra,
    });

    beforeEach(() => {
      prisma.descarteOffline = {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: any) => Promise.resolve({ id: 1, ...data })),
      };
      jest
        .spyOn(
          require('../bitacora/bitacora.service').BitacoraService,
          'registrarEnTransaccion',
        )
        .mockResolvedValue({} as any);
    });

    it('registra el descarte y lo cuenta como folio rendido', async () => {
      const res = await declarar({}, [await descarteBase()]);

      expect(res.declarados).toBe(1);
      const datos = prisma.dispositivoTaquilla.update.mock.calls[0][0].data;
      expect(datos.foliosRendidos).toEqual({ increment: 1 });
    });

    // Sin comprobar la firma, una taquilla podría declarar folios de otra y
    // ensuciarle el cuadre a alguien más.
    it('rechaza declarar un folio que no firmó esta taquilla', async () => {
      const otra = await crearTaquilla();
      const res = await declarar({}, [
        await descarteBase({ firma: await otra.firmar(FOLIO) }),
      ]);

      expect(res.resultados[0]).toMatchObject({ codigo: 'FIRMA_INVALIDA' });
    });

    // Sería borrar del cuadre una venta que sí entró.
    it('rechaza declarar descartado un folio que ya es ticket', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 99 });
      const res = await declarar({}, [await descarteBase()]);

      expect(res.resultados[0]).toMatchObject({ codigo: 'FOLIO_YA_EMITIDO' });
    });

    /**
     * Una taquilla revocada SÍ puede declarar, a diferencia de emitir. Es el caso en
     * que más importa: el equipo se dio de baja y lo que cobró tiene que poder
     * rendirse igual, o el dinero queda sin explicación para siempre.
     */
    it('una taquilla revocada puede declarar lo que cobró', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue({
        ...taquilla.registro,
        revocado: true,
      });

      const res = await declarar({}, [await descarteBase()]);
      expect(res.declarados).toBe(1);
    });

    /**
     * Anular y descartar consumen un folio igual, pero significan cosas distintas:
     * descartar es tirar un cobro ya hecho, anular es una venta que no existió. Sin
     * separarlos, una taquilla con veinte anulaciones legítimas se ve igual que una
     * con veinte cobros desviados y la cifra deja de señalar nada.
     */
    it('distingue una anulación de un cobro descartado', async () => {
      await declarar({}, [await descarteBase({ tipo: 'ANULADO' })]);

      expect(prisma.descarteOffline.create.mock.calls[0][0].data.tipo).toBe(
        'ANULADO',
      );
      expect(
        require('../bitacora/bitacora.service').BitacoraService
          .registrarEnTransaccion,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ accion: 'ANULAR_RECAUDACION_OFFLINE' }),
      );
    });

    /**
     * La fila no puede mezclar convenciones: `fechaCreacion` es reloj de pared y si
     * `fechaDescarte` se guardara como instante real, el primer reporte que las
     * pusiera juntas mostraría el descarte seis horas corrido respecto del ticket
     * que lo acompaña. Hoy nadie lee la columna, y por eso el momento de fijarlo
     * es ahora: cuando alguien la lea, el desfase ya estaría en los datos viejos.
     */
    it('guarda la fecha del descarte en reloj de pared, como su vecina', async () => {
      const cuandoSeDescarto = new Date(APERTURA.getTime() + 30 * 60 * 1000);
      await declarar({}, [
        await descarteBase({ fechaDescarte: cuandoSeDescarto.toISOString() }),
      ]);

      const datos = prisma.descarteOffline.create.mock.calls[0][0].data;
      expect(datos.fechaDescarte).toEqual(getFechaUTC6(cuandoSeDescarto));
      // La brecha entre las dos columnas es el rato que pasó entre descartar y
      // declarar. Con las convenciones cruzadas serían esos minutos ±360.
      const brecha = (datos.fechaCreacion - datos.fechaDescarte) / 60000;
      const transcurrido = (Date.now() - cuandoSeDescarto.getTime()) / 60000;
      expect(Math.abs(brecha - transcurrido)).toBeLessThan(2);
    });

    // El reloj del equipo tampoco es confiable acá: sin acotar, una taquilla podría
    // fechar el descarte en otro turno y sacarlo del cuadre que le corresponde.
    it('acota al turno un descarte fechado antes de abrir la caja', async () => {
      const antesDeAbrir = new Date(APERTURA.getTime() - 2 * 60 * 60 * 1000);
      await declarar({}, [
        await descarteBase({ fechaDescarte: antesDeAbrir.toISOString() }),
      ]);

      const datos = prisma.descarteOffline.create.mock.calls[0][0].data;
      expect(datos.fechaDescarte).toEqual(getFechaUTC6(APERTURA));
    });

    // Quien no declare el tipo queda registrado como dinero cobrado y tirado: si el
    // valor por omisión fuera el benigno, omitirlo sería la forma de esconderlo.
    it('sin tipo declarado asume el caso grave', async () => {
      await declarar({}, [await descarteBase()]);

      expect(prisma.descarteOffline.create.mock.calls[0][0].data.tipo).toBe(
        'DESCARTADO',
      );
      expect(
        require('../bitacora/bitacora.service').BitacoraService
          .registrarEnTransaccion,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ accion: 'DESCARTAR_RECAUDACION_OFFLINE' }),
      );
    });

    it('reintentar la declaración no la duplica ni cuenta dos veces el folio', async () => {
      prisma.descarteOffline.findUnique.mockResolvedValue({ id: 5 });
      const res = await declarar({}, [await descarteBase()]);

      expect(res.resultados[0]).toMatchObject({ estado: 'DUPLICADO_IGNORADO' });
      expect(prisma.dispositivoTaquilla.update).not.toHaveBeenCalled();
    });
  });

  describe('idempotencia', () => {
    // Reintentar tras un timeout ambiguo no puede cobrar dos veces.
    it('una venta ya registrada se ignora en vez de duplicarse', async () => {
      prisma.ticket.findFirst.mockResolvedValue({ id: 55 });
      const ticketsService = {
        findOne: jest.fn().mockResolvedValue({ id: 55 }),
      };
      (service as any).ticketsService = ticketsService;

      const res = (await subir({}, [await ventaBase()])).resultados[0];

      expect(res).toMatchObject({ estado: 'DUPLICADO_IGNORADO' });
      expect(ticketsService.findOne).toHaveBeenCalledWith(55);
    });
  });

  /**
   * La venta completa, hasta escribir el ticket.
   *
   * No había ninguna prueba que llegara hasta acá en este modo: las demás cortan
   * antes —rechazan la firma, acotan la fecha con `prepararEmision` fallando a
   * propósito— y por eso pasaban todas mientras el modo entero estaba roto en
   * producción. El camino común sellaba el folio con `marcarEmitido`, que en este
   * modo recibe el `id: null` de `tomarFolioFirmado` porque no hay folio reservado
   * que sellar, y SQL Server rechazaba la transacción completa: «Argument `id` must
   * not be null». Ninguna venta firmada por taquilla podía sincronizarse.
   *
   * La lección para el resto del archivo: una prueba que mockea el paso siguiente
   * para aislar el que mira, no cubre lo que pasa después de ese paso.
   */
  describe('la venta llega hasta el ticket', () => {
    beforeEach(() => {
      (service as any).ticketsService = {
        prepararEmision: jest.fn().mockResolvedValue({
          atraccion: { id: 1, nombre: 'Cuevas' },
          origen: { id: 1, codigo: 'nacional', nombre: 'Nacional' },
          tipoRecorrido: { id: 1 },
          opcionPago: { id: 1, nombre: 'Efectivo', esEfectivo: true },
          idPais: null,
          detalles: [
            {
              idTipoVisitante: 1,
              cantidad: 1,
              precioUnitario: new Prisma.Decimal(20),
              subtotal: new Prisma.Decimal(20),
            },
          ],
          montoVisitantes: new Prisma.Decimal(20),
          totalPersonas: 1,
        }),
        resolverGuia: jest.fn().mockResolvedValue(null),
        findOne: jest.fn().mockResolvedValue({ id: 292, numeroTicket: FOLIO }),
      };

      prisma.ticket.create = jest.fn(({ data }: any) =>
        Promise.resolve({ id: 292, numeroTicket: data.numeroTicket }),
      );
      prisma.grupoEmision = { create: jest.fn().mockResolvedValue({ id: 70 }) };
      // Si el código lo tocara, la prueba lo delata en vez de pasar en silencio.
      prisma.folioReservado = { update: jest.fn(), findUnique: jest.fn() };
      jest
        .spyOn(
          require('../bitacora/bitacora.service').BitacoraService,
          'registrarEnTransaccion',
        )
        .mockResolvedValue({} as any);
    });

    it('crea el ticket y devuelve CREADO', async () => {
      const res = await subir({}, [await ventaBase()]);

      expect(res.resultados[0]).toMatchObject({
        idLocal: 'local-1',
        estado: 'CREADO',
      });
      expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
    });

    /**
     * El folio de esta taquilla no tiene fila que marcar: lo que impide que respalde
     * dos cobros es el `@unique` de `numeroTicket`, comprobado antes de crear. Tocar
     * `FolioReservado` acá es el error que rompía la sincronización.
     */
    it('no toca FolioReservado, que en este modo no existe', async () => {
      await subir({}, [await ventaBase()]);

      expect(prisma.folioReservado.update).not.toHaveBeenCalled();
    });

    /**
     * Un fallo del servidor no puede disfrazarse de dato malo.
     *
     * `CATALOGO_INVALIDO` manda a revisar la atracción y el país de la venta, y la
     * documentación dice que un rechazo del servidor no se reintenta: con ese código,
     * un bug nuestro invita al taquillero a descartar dinero ya cobrado. Es lo que
     * pasó con el `folioReservado.update()` de `id: null`.
     */
    it('un fallo inesperado se reporta como ERROR_INTERNO, no como catálogo malo', async () => {
      prisma.ticket.create = jest
        .fn()
        .mockRejectedValue(new Error('Argument `id` must not be null.'));

      const res = (await subir({}, [await ventaBase()])).resultados[0];

      expect(res.codigo).toBe('ERROR_INTERNO');
      expect(res.mensaje).toMatch(/NO la descarte/);
    });

    // Un rechazo previsto conserva su código: es dato que el taquillero sí corrige.
    it('un rechazo previsto conserva su propio código', async () => {
      (service as any).ticketsService.prepararEmision.mockResolvedValue({
        ...(await (service as any).ticketsService.prepararEmision()),
        opcionPago: { id: 2, nombre: 'Tarjeta', esEfectivo: false },
      });

      const res = (await subir({}, [await ventaBase()])).resultados[0];

      expect(res.codigo).toBe('PAGO_NO_EFECTIVO');
    });

    it('cuenta el folio como rendido por la taquilla', async () => {
      await subir({}, [await ventaBase()]);

      const datos = prisma.dispositivoTaquilla.update.mock.calls[0][0].data;
      expect(datos.foliosRendidos).toEqual({ increment: 1 });
    });
  });
});
