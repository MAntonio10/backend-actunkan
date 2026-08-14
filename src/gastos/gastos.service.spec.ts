import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { GastosService } from './gastos.service';

const EJECUTOR = { id: 1, email: 'qa@test.com' };

const crearTxMock = () => ({
  gastos: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  tipoGasto: { findUnique: jest.fn().mockResolvedValue({ id: 1, nombre: 'Insumos', anulado: false }) },
  // Por defecto la caja está abierta; los casos de caja cerrada lo sobrescriben.
  aperturaCaja: {
    findUnique: jest.fn().mockResolvedValue({ id: 5, anulado: false, estado: { nombre: 'Abierta' } }),
  },
  usuario: { findUnique: jest.fn().mockResolvedValue({ id: 1, nombre: 'QA Tester' }) },
});

describe('GastosService', () => {
  let service: GastosService;
  let tx: ReturnType<typeof crearTxMock>;
  let prisma: any;
  let cajasService: any;

  beforeEach(async () => {
    tx = crearTxMock();
    prisma = {
      $transaction: jest.fn((cb: any) => cb(tx)),
      gastos: { findMany: jest.fn(), findUnique: jest.fn() },
    };
    cajasService = { obtenerActual: jest.fn() };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        GastosService,
        { provide: PrismaService, useValue: prisma },
        { provide: CajasService, useValue: cajasService },
      ],
    }).compile();

    service = modulo.get<GastosService>(GastosService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('create', () => {
    it('asocia el gasto a la caja abierta actual y lo registra en bitácora', async () => {
      cajasService.obtenerActual.mockResolvedValue({ id: 5 });
      tx.gastos.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 20, ...data }));

      const res = await service.create(
        { idTipoGasto: 1, descripcion: 'QA-TEST-insumos', monto: 150 },
        EJECUTOR,
      );

      expect(res.idAperturaCaja).toBe(5);
      expect(res.idUsuario).toBe(1); // queda registrado quién hizo el gasto
      expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ accion: 'CREAR_GASTO', modulo: 'Gastos' }),
      );
    });

    it('rechaza registrar un gasto si no hay caja abierta', async () => {
      cajasService.obtenerActual.mockResolvedValue(null);

      await expect(
        service.create({ idTipoGasto: 1, descripcion: 'x', monto: 10 }, EJECUTOR),
      ).rejects.toThrow(BadRequestException);
      expect(tx.gastos.create).not.toHaveBeenCalled();
    });

    it('rechaza un tipo de gasto anulado', async () => {
      cajasService.obtenerActual.mockResolvedValue({ id: 5 });
      tx.tipoGasto.findUnique.mockResolvedValue({ id: 1, nombre: 'Viejo', anulado: true });

      await expect(
        service.create({ idTipoGasto: 1, descripcion: 'x', monto: 10 }, EJECUTOR),
      ).rejects.toThrow(BadRequestException);
      expect(tx.gastos.create).not.toHaveBeenCalled();
    });

    // La caja puede cerrarse entre obtenerActual() y el insert: el gasto quedaría
    // colgado de una caja ya cerrada, invalidando el arqueo ya calculado.
    it('verifica dentro de la transacción que la caja siga abierta', async () => {
      cajasService.obtenerActual.mockResolvedValue({ id: 5 });
      tx.gastos.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 20, ...data }));

      await service.create({ idTipoGasto: 1, descripcion: 'x', monto: 10 }, EJECUTOR);

      expect(tx.aperturaCaja.findUnique).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rechaza editar un gasto inexistente', async () => {
      tx.gastos.findUnique.mockResolvedValue(null);

      await expect(service.update(404, { monto: 10 }, EJECUTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    // Editar el monto de un gasto de una caja ya cerrada altera de forma retroactiva
    // el arqueo: el CierreCaja guardado deja de cuadrar con sus gastos.
    it('rechaza editar un gasto cuya caja ya fue cerrada', async () => {
      tx.gastos.findUnique.mockResolvedValue({ id: 20, idAperturaCaja: 5, monto: 100 });
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 5,
        anulado: false,
        estado: { nombre: 'Cerrada' },
      });

      await expect(service.update(20, { monto: 999 }, EJECUTOR)).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.gastos.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('da de baja lógicamente, nunca con delete', async () => {
      tx.gastos.findUnique.mockResolvedValue({ id: 20, idAperturaCaja: 5, descripcion: 'x' });
      tx.gastos.update.mockResolvedValue({ id: 20, anulado: true, descripcion: 'x' });

      await service.remove(20, EJECUTOR);

      expect(tx.gastos.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ anulado: true }) }),
      );
      expect((tx.gastos as any).delete).toBeUndefined();
    });

    // Anular un gasto de una caja cerrada cambia el total de gastos a posteriori.
    it('rechaza anular un gasto cuya caja ya fue cerrada', async () => {
      tx.gastos.findUnique.mockResolvedValue({ id: 20, idAperturaCaja: 5, descripcion: 'x' });
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 5,
        anulado: false,
        estado: { nombre: 'Cerrada' },
      });

      await expect(service.remove(20, EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.gastos.update).not.toHaveBeenCalled();
    });
  });
});
