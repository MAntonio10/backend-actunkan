import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from './cajas.service';

const EJECUTOR = { id: 1, email: 'qa@test.com' };

const crearTxMock = () => ({
  aperturaCaja: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  cierreCaja: { create: jest.fn(), update: jest.fn() },
  estadoCaja: {
    findFirst: jest.fn(({ where }: any) =>
      Promise.resolve(
        where.nombre === 'Abierta' ? { id: 1, nombre: 'Abierta' } : { id: 2, nombre: 'Cerrada' },
      ),
    ),
  },
  gastos: { aggregate: jest.fn().mockResolvedValue({ _sum: { monto: 0 } }) },
  ticketPago: { aggregate: jest.fn().mockResolvedValue({ _sum: { monto: 0 } }) },
  usuario: { findUnique: jest.fn().mockResolvedValue({ id: 1, nombre: 'QA Tester' }) },
});

describe('CajasService', () => {
  let service: CajasService;
  let tx: ReturnType<typeof crearTxMock>;
  let prisma: any;

  beforeEach(async () => {
    tx = crearTxMock();
    prisma = {
      $transaction: jest.fn((cb: any) => cb(tx)),
      aperturaCaja: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
      gastos: { aggregate: jest.fn().mockResolvedValue({ _sum: { monto: 0 } }) },
      ticketPago: { aggregate: jest.fn().mockResolvedValue({ _sum: { monto: 0 } }) },
    };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [CajasService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = modulo.get<CajasService>(CajasService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('abrirCaja', () => {
    it('abre la caja y registra en bitácora dentro de la transacción', async () => {
      tx.aperturaCaja.findFirst.mockResolvedValue(null);
      tx.aperturaCaja.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 10, ...data }),
      );

      const res = await service.abrirCaja({ montoInicial: 500 }, EJECUTOR);

      expect(res.id).toBe(10);
      expect(tx.aperturaCaja.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ idUsuario: 1, montoInicial: 500, idEstado: 1 }),
        }),
      );
      expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ accion: 'APERTURA_CAJA', modulo: 'Cajas' }),
      );
    });

    it('rechaza abrir una segunda caja si ya hay una abierta', async () => {
      tx.aperturaCaja.findFirst.mockResolvedValue({ id: 7 });

      await expect(service.abrirCaja({ montoInicial: 100 }, EJECUTOR)).rejects.toThrow(
        ConflictException,
      );
      expect(tx.aperturaCaja.create).not.toHaveBeenCalled();
    });

    it('rechaza abrir caja sin ejecutor identificado', async () => {
      await expect(service.abrirCaja({ montoInicial: 100 }, undefined)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('cerrarCaja / arqueo', () => {
    const prepararCajaAbierta = (montoInicial = 500) => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        montoInicial,
        estado: { nombre: 'Abierta' },
      });
      tx.cierreCaja.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 99, ...data }),
      );
      tx.aperturaCaja.update.mockResolvedValue({ id: 1 });
    };

    it('calcula montoEsperado = inicial + ventas efectivo - gastos', async () => {
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 1250 } });
      tx.gastos.aggregate.mockResolvedValue({ _sum: { monto: 150 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 1600 }, EJECUTOR);

      expect(cierre.montoEsperado!.toNumber()).toBe(1600);
      expect(cierre.diferencia!.toNumber()).toBe(0);
    });

    it('reporta faltante cuando lo contado es menor a lo esperado', async () => {
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 1250 } });
      tx.gastos.aggregate.mockResolvedValue({ _sum: { monto: 150 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 1590 }, EJECUTOR);

      expect(cierre.diferencia!.toNumber()).toBe(-10);
    });

    it('reporta sobrante cuando lo contado es mayor a lo esperado', async () => {
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 0 } });
      tx.gastos.aggregate.mockResolvedValue({ _sum: { monto: 0 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 520 }, EJECUTOR);

      expect(cierre.diferencia!.toNumber()).toBe(20);
    });

    it('trata sumas nulas (sin ventas ni gastos) como 0', async () => {
      prepararCajaAbierta(300);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: null } });
      tx.gastos.aggregate.mockResolvedValue({ _sum: { monto: null } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 300 }, EJECUTOR);

      expect(cierre.montoEsperado!.toNumber()).toBe(300);
      expect(cierre.diferencia!.toNumber()).toBe(0);
    });

    it('mantiene exactitud decimal en el arqueo (sin error de punto flotante)', async () => {
      prepararCajaAbierta(0.1);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 0.2 } });
      tx.gastos.aggregate.mockResolvedValue({ _sum: { monto: 0 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 0.3 }, EJECUTOR);

      // Con aritmética float daría 0.30000000000000004 y una diferencia distinta de 0.
      expect(cierre.montoEsperado!.toString()).toBe('0.3');
      expect(cierre.diferencia!.toNumber()).toBe(0);
    });

    it('solo cuenta pagos en efectivo no anulados de tickets de esa caja', async () => {
      prepararCajaAbierta(0);
      await service.cerrarCaja(1, { montoContado: 0 }, EJECUTOR);

      expect(tx.ticketPago.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            anulado: false,
            opcionPago: { esEfectivo: true },
            tickets: { idAperturaCaja: 1, anulado: false },
          }),
        }),
      );
    });

    it('rechaza cerrar una caja ya cerrada', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        montoInicial: 100,
        estado: { nombre: 'Cerrada' },
      });

      await expect(service.cerrarCaja(1, { montoContado: 100 }, EJECUTOR)).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.cierreCaja.create).not.toHaveBeenCalled();
    });

    it('rechaza cerrar una caja inexistente', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue(null);

      await expect(service.cerrarCaja(404, { montoContado: 100 }, EJECUTOR)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('anularCierre', () => {
    it('anula el cierre vigente y reabre la caja', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        estado: { nombre: 'Cerrada' },
        cierresCaja: [{ id: 50, anulado: false }],
      });
      tx.aperturaCaja.update.mockResolvedValue({ id: 1 });

      await service.anularCierre(1, EJECUTOR);

      expect(tx.cierreCaja.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 50 }, data: { anulado: true } }),
      );
      expect(tx.aperturaCaja.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ idEstado: 1 }) }),
      );
    });

    it('rechaza anular cuando no hay cierre vigente', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        estado: { nombre: 'Abierta' },
        cierresCaja: [],
      });

      await expect(service.anularCierre(1, EJECUTOR)).rejects.toThrow(BadRequestException);
    });

    // INVARIANTE DEL SISTEMA: solo una caja abierta a la vez.
    it('NO debe reabrir la caja si ya existe otra caja abierta', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        estado: { nombre: 'Cerrada' },
        cierresCaja: [{ id: 50, anulado: false }],
      });
      // Otra caja distinta ya está abierta en el sistema
      tx.aperturaCaja.findFirst.mockResolvedValue({ id: 2, estado: { nombre: 'Abierta' } });
      tx.aperturaCaja.update.mockResolvedValue({ id: 1 });

      await expect(service.anularCierre(1, EJECUTOR)).rejects.toThrow(ConflictException);
    });
  });

  describe('anularApertura', () => {
    it('da de baja lógicamente, nunca con delete', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        estado: { nombre: 'Abierta' },
      });
      tx.aperturaCaja.update.mockResolvedValue({ id: 1, anulado: true });

      await service.anularApertura(1, EJECUTOR);

      expect(tx.aperturaCaja.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ anulado: true }) }),
      );
      expect((tx.aperturaCaja as any).delete).toBeUndefined();
    });

    it('rechaza anular una apertura ya cerrada', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        estado: { nombre: 'Cerrada' },
      });

      await expect(service.anularApertura(1, EJECUTOR)).rejects.toThrow(BadRequestException);
    });

    it('rechaza anular una apertura ya anulada', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        anulado: true,
        estado: { nombre: 'Abierta' },
      });

      await expect(service.anularApertura(1, EJECUTOR)).rejects.toThrow(BadRequestException);
    });
  });
});
