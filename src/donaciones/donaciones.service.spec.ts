import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { DonacionesService } from './donaciones.service';

const EJECUTOR = { id: 1, email: 'qa@test.com' };

const crearTxMock = () => {
  const tx: any = {
    aperturaCaja: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 9, anulado: false, estado: { nombre: 'Abierta' } }),
    },
    correlativo: { upsert: jest.fn().mockResolvedValue({ ultimoNumero: 7 }) },
    donacion: {
      create: jest.fn(({ data }: any) => Promise.resolve({ id: 30, ...data })),
      findUnique: jest.fn(),
      update: jest.fn(({ data }: any) =>
        Promise.resolve({ id: 30, numeroRecibo: 'DON-2026-000007', monto: 100, ...data }),
      ),
    },
    usuario: { findUnique: jest.fn().mockResolvedValue({ id: 1, nombre: 'QA Tester' }) },
  };
  return tx;
};

describe('DonacionesService', () => {
  let service: DonacionesService;
  let tx: any;
  let prisma: any;
  let cajasService: any;

  beforeEach(async () => {
    tx = crearTxMock();
    prisma = {
      $transaction: jest.fn((cb: any) => cb(tx)),
      donacion: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    };
    cajasService = { obtenerActual: jest.fn().mockResolvedValue({ id: 9 }) };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        DonacionesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CajasService, useValue: cajasService },
      ],
    }).compile();

    service = modulo.get<DonacionesService>(DonacionesService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('crear', () => {
    it('genera el folio con la serie DON, independiente de los tickets', async () => {
      const res = await service.crear({ monto: 100, nombreDonante: 'Ana' }, EJECUTOR);

      const anio = new Date().getFullYear();
      expect(res.numeroRecibo).toBe(`DON-${anio}-000007`);
      expect(tx.correlativo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { serie_anio: { serie: 'DON', anio } },
        }),
      );
    });

    it('asocia la donación a la caja abierta y registra en bitácora', async () => {
      const res = await service.crear({ monto: 100 }, EJECUTOR);

      expect(res.idAperturaCaja).toBe(9);
      expect(res.idUsuario).toBe(1);
      expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ accion: 'REGISTRAR_DONACION', modulo: 'Donaciones' }),
      );
    });

    // El donante puede permanecer anónimo.
    it('acepta una donación sin nombre de donante', async () => {
      const res = await service.crear({ monto: 50 }, EJECUTOR);
      expect(res.nombreDonante).toBeNull();
    });

    it('guarda el nombre sin espacios sobrantes', async () => {
      const res = await service.crear({ monto: 50, nombreDonante: '  Ana Lucía  ' }, EJECUTOR);
      expect(res.nombreDonante).toBe('Ana Lucía');
    });

    it('rechaza registrar si no hay caja abierta', async () => {
      cajasService.obtenerActual.mockResolvedValue(null);

      await expect(service.crear({ monto: 100 }, EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.donacion.create).not.toHaveBeenCalled();
    });

    it('rechaza si la caja se cerró dentro de la transacción', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 9,
        anulado: false,
        estado: { nombre: 'Cerrada' },
      });

      await expect(service.crear({ monto: 100 }, EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.donacion.create).not.toHaveBeenCalled();
    });

    it('rechaza si no se puede identificar al usuario', async () => {
      await expect(service.crear({ monto: 100 }, undefined)).rejects.toThrow(BadRequestException);
    });
  });

  describe('anular', () => {
    it('da de baja lógicamente y guarda el motivo', async () => {
      tx.donacion.findUnique.mockResolvedValue({
        id: 30,
        numeroRecibo: 'DON-2026-000007',
        anulado: false,
        idAperturaCaja: 9,
        monto: 100,
      });

      const res = await service.anular(30, 'Error de captura', EJECUTOR);

      expect(res.anulado).toBe(true);
      expect(res.motivoAnulacion).toBe('Error de captura');
      expect(tx.donacion.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ anulado: true }) }),
      );
    });

    // Anularla tras el cierre cambiaría un arqueo ya guardado.
    it('rechaza anular si la caja de origen ya se cerró', async () => {
      tx.donacion.findUnique.mockResolvedValue({
        id: 30,
        numeroRecibo: 'DON-2026-000007',
        anulado: false,
        idAperturaCaja: 9,
      });
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 9,
        anulado: false,
        estado: { nombre: 'Cerrada' },
      });

      await expect(service.anular(30, undefined, EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.donacion.update).not.toHaveBeenCalled();
    });

    it('rechaza anular dos veces', async () => {
      tx.donacion.findUnique.mockResolvedValue({
        id: 30,
        numeroRecibo: 'DON-2026-000007',
        anulado: true,
        idAperturaCaja: 9,
      });

      await expect(service.anular(30, undefined, EJECUTOR)).rejects.toThrow(BadRequestException);
    });

    it('rechaza una donación inexistente', async () => {
      tx.donacion.findUnique.mockResolvedValue(null);

      await expect(service.anular(404, undefined, EJECUTOR)).rejects.toThrow(NotFoundException);
    });
  });
});
