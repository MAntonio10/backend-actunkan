import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { SesionesService } from './sesiones.service';
import { getFechaUTC6 } from '../common/utils/date.util';

const hashear = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Todo el proyecto maneja las fechas con `getFechaUTC6()`, que desplaza el reloj
 * 6 horas. Las comparaciones del servicio usan esa misma base, así que las fechas
 * de prueba deben construirse igual: usar `Date.now()` real daría 6 h de desfase.
 */
const desdeAhoraUTC6 = (ms: number) => new Date(getFechaUTC6().getTime() + ms);

const USUARIO = { id: 1, nombre: 'QA Tester', anulado: false };

describe('SesionesService', () => {
  let service: SesionesService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      sesionRefresh: {
        create: jest.fn(({ data }: any) => Promise.resolve({ id: 10, ...data })),
        findUnique: jest.fn(),
        update: jest.fn(({ data }: any) => Promise.resolve({ id: 10, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
      bitacora: { create: jest.fn() },
    };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [SesionesService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = modulo.get<SesionesService>(SesionesService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('crear', () => {
    it('guarda solo el hash, nunca el token en claro', async () => {
      const { refreshToken } = await service.crear(1, true);

      const guardado = prisma.sesionRefresh.create.mock.calls[0][0].data;
      expect(guardado.tokenHash).toBe(hashear(refreshToken));
      expect(guardado.tokenHash).not.toBe(refreshToken);
      expect(JSON.stringify(guardado)).not.toContain(refreshToken);
    });

    it('dura 30 días con "Recordarme"', async () => {
      const { sesion } = await service.crear(1, true);
      const dias =
        (sesion.fechaExpiracion.getTime() - sesion.fechaCreacion.getTime()) / 86_400_000;
      expect(Math.round(dias)).toBe(30);
    });

    it('dura 24 horas sin "Recordarme"', async () => {
      const { sesion } = await service.crear(1, false);
      const horas =
        (sesion.fechaExpiracion.getTime() - sesion.fechaCreacion.getTime()) / 3_600_000;
      expect(Math.round(horas)).toBe(24);
    });

    it('genera tokens distintos en cada login', async () => {
      const a = await service.crear(1, true);
      const b = await service.crear(1, true);
      expect(a.refreshToken).not.toBe(b.refreshToken);
    });
  });

  describe('rotar', () => {
    const sesionVigente = (extra: any = {}) => ({
      id: 10,
      idUsuario: 1,
      revocada: false,
      fechaExpiracion: desdeAhoraUTC6(86_400_000),
      ip: '127.0.0.1',
      dispositivo: 'jest',
      usuario: USUARIO,
      ...extra,
    });

    it('rota el token: revoca el anterior y emite uno nuevo', async () => {
      prisma.sesionRefresh.findUnique.mockResolvedValue(sesionVigente());

      const { refreshToken } = await service.rotar('token-viejo');

      expect(refreshToken).not.toBe('token-viejo');
      expect(prisma.sesionRefresh.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 10 },
          data: expect.objectContaining({ revocada: true }),
        }),
      );
    });

    it('conserva la expiración original: refrescar no alarga la sesión', async () => {
      const expiracion = desdeAhoraUTC6(5 * 86_400_000);
      prisma.sesionRefresh.findUnique.mockResolvedValue(
        sesionVigente({ fechaExpiracion: expiracion }),
      );

      await service.rotar('token');

      const creada = prisma.sesionRefresh.create.mock.calls[0][0].data;
      expect(creada.fechaExpiracion).toEqual(expiracion);
    });

    it('rechaza un token inexistente', async () => {
      prisma.sesionRefresh.findUnique.mockResolvedValue(null);
      await expect(service.rotar('desconocido')).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza un token expirado', async () => {
      prisma.sesionRefresh.findUnique.mockResolvedValue(
        sesionVigente({ fechaExpiracion: desdeAhoraUTC6(-1000) }),
      );
      await expect(service.rotar('vencido')).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza si el usuario fue anulado', async () => {
      prisma.sesionRefresh.findUnique.mockResolvedValue(
        sesionVigente({ usuario: { ...USUARIO, anulado: true } }),
      );
      await expect(service.rotar('token')).rejects.toThrow(UnauthorizedException);
    });

    // Reutilizar un token ya rotado delata que alguien más lo tiene.
    it('ante reutilización de un token revocado cierra TODAS las sesiones del usuario', async () => {
      prisma.sesionRefresh.findUnique.mockResolvedValue(sesionVigente({ revocada: true }));

      await expect(service.rotar('robado')).rejects.toThrow(UnauthorizedException);

      expect(prisma.sesionRefresh.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ idUsuario: 1, revocada: false }),
          data: expect.objectContaining({ revocada: true }),
        }),
      );
      expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ accion: 'ALERTA_SESION' }),
      );
    });
  });

  describe('revocación', () => {
    it('cerrar una sesión no toca las demás', async () => {
      prisma.sesionRefresh.findUnique.mockResolvedValue({
        id: 10,
        idUsuario: 1,
        revocada: false,
      });

      await service.revocarUna('token');

      // update apunta a una sola fila; updateMany (masivo) no se usa.
      expect(prisma.sesionRefresh.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 10 } }),
      );
      expect(prisma.sesionRefresh.updateMany).not.toHaveBeenCalled();
    });

    it('revocar todas se limita al usuario indicado', async () => {
      await service.revocarTodas(7, 'prueba');

      expect(prisma.sesionRefresh.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ idUsuario: 7 }) }),
      );
    });

    it('cerrar una sesión ajena por id no hace nada', async () => {
      prisma.sesionRefresh.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.revocarPorId(1, 999)).rejects.toThrow(UnauthorizedException);
    });
  });
});
