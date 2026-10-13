import { webcrypto } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { DispositivosService } from './dispositivos.service';

const EJECUTOR = { id: 3, email: 'admin@test.com' };

async function llavePublicaValida(): Promise<string> {
  const par = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  return Buffer.from(
    await webcrypto.subtle.exportKey('spki', par.publicKey),
  ).toString('base64');
}

const CAJA_ABIERTA = {
  id: 98,
  fechaCreacion: new Date('2026-10-02T08:00:00.000Z'),
};

describe('DispositivosService', () => {
  let service: DispositivosService;
  let prisma: any;
  let cajas: any;
  let llave: string;

  const registrado = (extra: any = {}) => ({
    id: 7,
    idDispositivo: 'disp-03',
    nombre: 'Taquilla 1',
    serie: 'D03',
    llavePublica: 'anterior',
    ultimoCorrelativo: 450,
    revocado: false,
    ...extra,
  });

  beforeEach(async () => {
    llave = await llavePublicaValida();

    prisma = {
      $transaction: jest.fn((cb: any) => cb(prisma)),
      dispositivoTaquilla: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(({ data }: any) => Promise.resolve({ id: 7, ...data })),
        update: jest.fn(({ data }: any) =>
          Promise.resolve({ ...registrado(), ...data }),
        ),
      },
      usuario: {
        findUnique: jest.fn().mockResolvedValue({ id: 3, nombre: 'Admin' }),
      },
    };

    jest
      .spyOn(BitacoraService, 'registrarEnTransaccion')
      .mockResolvedValue({} as any);

    cajas = { obtenerActual: jest.fn().mockResolvedValue(CAJA_ABIERTA) };

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        DispositivosService,
        { provide: PrismaService, useValue: prisma },
        { provide: CajasService, useValue: cajas },
      ],
    }).compile();

    service = modulo.get<DispositivosService>(DispositivosService);
  });

  afterEach(() => jest.restoreAllMocks());

  const alta = (extra: any = {}) =>
    service.registrar(
      { idDispositivo: 'disp-03', llavePublica: llave, ...extra },
      EJECUTOR,
    );

  /**
   * El fallo tiene que ocurrir acá y no al sincronizar.
   *
   * Sin caja abierta el equipo se armaba igual y el taquillero cobraba el turno
   * completo; el servidor recién rechazaba al subir las ventas, cuando el dinero ya
   * estaba en el cajón y los visitantes dentro del parque. Esa no es una validación
   * que falle: es una que avisa tarde. Armar el equipo es el único momento con red y
   * sin dinero cobrado, o sea el único donde todavía se puede corregir gratis.
   */
  describe('exige caja abierta para habilitar la taquilla', () => {
    it('sin caja abierta no registra nada', async () => {
      cajas.obtenerActual.mockResolvedValue(null);

      await expect(alta()).rejects.toThrow(ConflictException);
      expect(prisma.dispositivoTaquilla.create).not.toHaveBeenCalled();
      expect(prisma.dispositivoTaquilla.update).not.toHaveBeenCalled();
    });

    // El código dice qué hacer; el mensaje suelto obliga a adivinar.
    it('el rechazo trae código propio y dice que hay que abrir la caja', async () => {
      cajas.obtenerActual.mockResolvedValue(null);

      await expect(alta()).rejects.toMatchObject({
        response: { codigo: 'SIN_CAJA_ABIERTA' },
      });
      await expect(alta()).rejects.toThrow(/Abra la caja/);
    });

    // Renovar la llave también arma el equipo para vender: misma exigencia.
    it('tampoco renueva la llave de un equipo ya registrado', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue(registrado());
      cajas.obtenerActual.mockResolvedValue(null);

      await expect(alta()).rejects.toThrow(ConflictException);
      expect(prisma.dispositivoTaquilla.update).not.toHaveBeenCalled();
    });

    /**
     * La caja viaja en la respuesta porque el dispositivo la necesita para trabajar.
     * Si tuviera que pedirla en una segunda llamada, esa llamada puede fallar cuando
     * ya no haya red, y el equipo quedaría armado sin saber contra qué cuadra.
     */
    it('devuelve la caja junto con la serie, en un solo viaje', async () => {
      const res = await alta();

      expect(res.caja).toEqual({
        id: 98,
        fechaCreacion: CAJA_ABIERTA.fechaCreacion,
      });
      expect(res.serie).toBeDefined();
    });
  });

  describe('la llave se valida antes de guardarla', () => {
    /**
     * Una llave ilegible aceptada aquí no falla ahora: falla semanas después, en el
     * torniquete, cuando ya no hay red para corregirla.
     */
    it.each(['no-es-base64', 'AAAA', ''])(
      'rechaza la llave %p',
      async (mala) => {
        await expect(alta({ llavePublica: mala })).rejects.toThrow(
          BadRequestException,
        );
        expect(prisma.dispositivoTaquilla.create).not.toHaveBeenCalled();
      },
    );

    it('acepta una ECDSA P-256 exportada en SPKI', async () => {
      await expect(alta()).resolves.toMatchObject({ serie: 'D01' });
    });
  });

  describe('la serie', () => {
    it('arranca en D01 cuando no hay ninguna', async () => {
      const res = await alta();
      expect(res.serie).toBe('D01');
    });

    it('toma la siguiente libre y no reutiliza huecos', async () => {
      // D02 pudo haberse revocado: su serie no vuelve a usarse, porque un folio
      // viejo de esa serie tiene que seguir señalando al equipo que lo emitió.
      prisma.dispositivoTaquilla.findMany.mockResolvedValue([
        { serie: 'D01' },
        { serie: 'D03' },
      ]);

      const res = await alta();
      expect(res.serie).toBe('D04');
    });

    it('un equipo que vuelve a registrarse conserva la suya', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue(registrado());

      const res = await alta();

      expect(res.serie).toBe('D03');
      expect(prisma.dispositivoTaquilla.create).not.toHaveBeenCalled();
    });
  });

  /**
   * INVARIANTE: `ultimoCorrelativo` solo sube, nunca baja ni se reinicia.
   *
   * El dispositivo se queda con el mayor entre su contador local y este, porque el
   * local va legítimamente adelante mientras tenga ventas emitidas sin conexión que
   * todavía no subió. Si el servidor pudiera bajarlo, la próxima venta repetiría un
   * folio ya impreso y el cobro se duplicaría.
   *
   * Estas pruebas existen para que agregar un "reiniciar contador" falle acá y no
   * en la taquilla.
   */
  describe('el correlativo nunca retrocede', () => {
    it('renovar la llave no lo toca', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue(registrado());

      await alta({ llavePublica: llave });

      const datos = prisma.dispositivoTaquilla.update.mock.calls[0][0].data;
      expect(datos).not.toHaveProperty('ultimoCorrelativo');
    });

    it('el alta lo devuelve para que el dispositivo siembre su contador', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue(registrado());

      const res = await alta();

      expect(res.ultimoCorrelativo).toBe(450);
    });

    it('un equipo nuevo arranca en 0, así que su primer folio es el 1', async () => {
      const res = await alta();
      expect(res.ultimoCorrelativo ?? 0).toBe(0);
    });

    it('revocar tampoco lo toca', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue(registrado());

      await service.revocar(7, EJECUTOR);

      const datos = prisma.dispositivoTaquilla.update.mock.calls[0][0].data;
      expect(datos).not.toHaveProperty('ultimoCorrelativo');
      expect(datos.revocado).toBe(true);
    });
  });

  describe('revocación', () => {
    // Se revoca porque se perdió el equipo o se sospecha de él. Dejar que vuelva
    // presentando una llave nueva vaciaría de sentido la revocación.
    it('un equipo revocado no se reactiva registrándose de nuevo', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue(
        registrado({ revocado: true }),
      );

      await expect(alta()).rejects.toThrow(ForbiddenException);
    });

    it('no se puede revocar dos veces', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue(
        registrado({ revocado: true }),
      );

      await expect(service.revocar(7, EJECUTOR)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('deja constancia en bitácora de qué taquilla se dio de baja', async () => {
      prisma.dispositivoTaquilla.findUnique.mockResolvedValue(registrado());

      await service.revocar(7, EJECUTOR);

      expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          accion: 'REVOCAR_DISPOSITIVO',
          modulo: 'Sincronizacion',
          descripcion: expect.stringContaining('D03'),
        }),
      );
    });
  });
});
