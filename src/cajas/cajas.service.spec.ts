import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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
  ticketPago: { aggregate: jest.fn().mockResolvedValue({ _sum: { monto: 0 } }) },
  // Las donaciones en efectivo entran al mismo cajón y suman al arqueo.
  donacion: {
    aggregate: jest.fn().mockResolvedValue({ _sum: { monto: 0 } }),
    count: jest.fn().mockResolvedValue(0),
  },
  ticket: {
    count: jest.fn().mockResolvedValue(0),
    // Ventas offline cobradas por un monto distinto al que correspondía.
    aggregate: jest
      .fn()
      .mockResolvedValue({ _count: { _all: 0 }, _sum: { montoTotal: 0, montoRecalculado: 0 } }),
  },
  loteOffline: {
    findFirst: jest.fn().mockResolvedValue(null),
    // Lotes offline activos de la caja: por defecto ninguno.
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
  },
  folioReservado: {
    count: jest.fn().mockResolvedValue(0),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
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
      ticketPago: { aggregate: jest.fn().mockResolvedValue({ _sum: { monto: 0 } }) },
      donacion: { aggregate: jest.fn().mockResolvedValue({ _sum: { monto: 0 } }) },
      ticket: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _count: { _all: 0 }, _sum: { montoTotal: 0, montoRecalculado: 0 } }),
      },
      // Decide si la respuesta revela el arqueo. Por defecto: supervisor.
      permisos: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
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

    /**
     * Una venta offline de las 10:00 que sube a las 16:00 no puede entrar en una
     * caja cerrada a las 14:00 sin corromper un arqueo ya guardado.
     */
    describe('lote offline pendiente', () => {
      /** Lote todavía vigente: el dispositivo aún puede estar vendiendo. */
      const conLoteActivo = (foliosReservados = 88) => {
        tx.loteOffline.findMany.mockResolvedValue([
          { id: 7, estado: 'ACTIVO', expiraEn: new Date(Date.now() + 8 * 3600_000) },
        ]);
        tx.folioReservado.count.mockResolvedValue(foliosReservados);
      };

      /** Lote que venció anoche y que el dispositivo ya reemplazó. */
      const conLoteVencido = () => {
        tx.loteOffline.findMany.mockResolvedValue([
          { id: 5, estado: 'ACTIVO', expiraEn: new Date(Date.now() - 8 * 3600_000) },
        ]);
        tx.folioReservado.count.mockResolvedValue(88);
      };

      it('bloquea el cierre con 409 y dice cuántos folios faltan liquidar', async () => {
        prepararCajaAbierta(500);
        conLoteActivo(88);

        await expect(service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR)).rejects.toMatchObject({
          response: { codigo: 'LOTE_OFFLINE_PENDIENTE', idLote: 7, foliosReservados: 88 },
        });
        expect(tx.cierreCaja.create).not.toHaveBeenCalled();
      });

      it('un lote ya conciliado no estorba', async () => {
        prepararCajaAbierta(500);
        tx.loteOffline.findMany.mockResolvedValue([]);

        await expect(
          service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR),
        ).resolves.toBeDefined();
      });

      /**
       * Si un lote vencido bloqueara, esa caja quedaría imposible de cerrar
       * esperando que alguien concilie un lote que el dispositivo ya reemplazó. Y
       * como solo puede haber una caja abierta, se bloquearía la operación entera.
       */
      describe('lote vencido', () => {
        it('no bloquea el cierre: se concilia solo', async () => {
          prepararCajaAbierta(500);
          conLoteVencido();

          await expect(
            service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR),
          ).resolves.toBeDefined();
          expect(tx.cierreCaja.create).toHaveBeenCalled();
        });

        it('sus folios quedan NO_UTILIZADO, no invalidados', async () => {
          prepararCajaAbierta(500);
          conLoteVencido();

          await service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR);

          expect(tx.folioReservado.updateMany).toHaveBeenCalledWith({
            where: { idLote: 5, estado: 'RESERVADO' },
            data: { estado: 'NO_UTILIZADO' },
          });
          expect(tx.loteOffline.update).toHaveBeenCalledWith({
            where: { id: 5 },
            data: expect.objectContaining({ estado: 'CONCILIADO' }),
          });
        });

        // No destruye ventas a escondidas: queda por qué se cerró solo.
        it('queda registrado en bitácora', async () => {
          prepararCajaAbierta(500);
          conLoteVencido();

          await service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR);

          expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({ accion: 'CONCILIAR_LOTE_OFFLINE_VENCIDO' }),
          );
        });

        // Cerrar un vencido no requiere ser supervisor: no hay nada que decidir.
        it('un cajero puede cerrar la caja con un lote vencido', async () => {
          prepararCajaAbierta(500);
          conLoteVencido();
          prisma.permisos.findFirst.mockResolvedValue(null);

          await expect(
            service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR),
          ).resolves.toBeDefined();
        });

        // El vencido se cierra, pero el vigente sigue exigiendo sincronizar.
        it('un vencido y uno vigente juntos: se concilia el vencido y el vigente bloquea', async () => {
          prepararCajaAbierta(500);
          tx.loteOffline.findMany.mockResolvedValue([
            { id: 5, estado: 'ACTIVO', expiraEn: new Date(Date.now() - 8 * 3600_000) },
            { id: 8, estado: 'ACTIVO', expiraEn: new Date(Date.now() + 8 * 3600_000) },
          ]);

          await expect(
            service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR),
          ).rejects.toMatchObject({ response: { codigo: 'LOTE_OFFLINE_PENDIENTE', idLote: 8 } });

          expect(tx.loteOffline.update).toHaveBeenCalledWith({
            where: { id: 5 },
            data: expect.objectContaining({ estado: 'CONCILIADO' }),
          });
        });
      });

      /**
       * Forzar destruye las ventas que el dispositivo no haya subido. El cajero
       * tiene `Cajas.Anular`, así que si el permiso fuera ese podría descartar sus
       * propias ventas pendientes y cerrar sin ellas.
       */
      it('forzar exige supervisión, no basta con ser cajero', async () => {
        prepararCajaAbierta(500);
        conLoteActivo();
        prisma.permisos.findFirst.mockResolvedValue(null); // sin Cajas.Editar

        await expect(
          service.cerrarCaja(1, { montoContado: 500, forzarLoteOffline: true }, EJECUTOR),
        ).rejects.toThrow(ForbiddenException);
        expect(tx.loteOffline.update).not.toHaveBeenCalled();
      });

      it('el supervisor sí puede forzar, e invalida el lote y sus folios', async () => {
        prepararCajaAbierta(500);
        conLoteActivo(88);

        await service.cerrarCaja(1, { montoContado: 500, forzarLoteOffline: true }, EJECUTOR);

        expect(tx.folioReservado.updateMany).toHaveBeenCalledWith({
          where: { idLote: 7, estado: 'RESERVADO' },
          data: { estado: 'INVALIDADO' },
        });
        expect(tx.loteOffline.update).toHaveBeenCalledWith({
          where: { id: 7 },
          data: { estado: 'INVALIDADO' },
        });
        expect(tx.cierreCaja.create).toHaveBeenCalled();
      });

      it('forzar queda registrado en bitácora con lo que se pierde', async () => {
        prepararCajaAbierta(500);
        conLoteActivo(88);

        await service.cerrarCaja(1, { montoContado: 500, forzarLoteOffline: true }, EJECUTOR);

        expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({ accion: 'FORZAR_CIERRE_LOTE_OFFLINE' }),
        );
      });
    });

    /**
     * Sin una cifra propia, un cobro de menos no deja huella: el pago se registró
     * por lo cobrado, así que el esperado coincide con lo contado y nadie se entera.
     */
    describe('discrepancia de ventas offline', () => {
      const conDiscrepancia = () => {
        const agregado = {
          _count: { _all: 2 },
          _sum: { montoTotal: 150, montoRecalculado: 170 },
        };
        tx.ticket.aggregate.mockResolvedValue(agregado);
        prisma.ticket.aggregate.mockResolvedValue(agregado);
      };

      it('reporta cuánto se cobró de menos', async () => {
        prepararCajaAbierta(500);
        conDiscrepancia();

        const res: any = await service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR);

        expect(res.discrepanciaOffline).toEqual({
          tickets: 2,
          montoCobrado: '150',
          montoRecalculado: '170',
          diferencia: '-20',
        });
      });

      /**
       * El esperado es el dinero que debería estar en el cajón, y en el cajón está
       * lo que se cobró. Restar la discrepancia haría aparecer un faltante que en
       * realidad es un error de tarifa, no de conteo.
       */
      it('no altera el monto esperado', async () => {
        prepararCajaAbierta(500);
        tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 150 } });
        conDiscrepancia();

        const { cierre } = await service.cerrarCaja(1, { montoContado: 650 }, EJECUTOR);

        expect(cierre.montoEsperado!.toNumber()).toBe(650);
        expect(cierre.diferencia!.toNumber()).toBe(0);
      });

      it('es null cuando ninguna venta offline se cobró mal', async () => {
        prepararCajaAbierta(500);

        const res: any = await service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR);

        expect(res.discrepanciaOffline).toBeNull();
      });

      // Misma regla que montoEsperado: quien cobró de menos no ve si lo detectaron.
      it('se oculta al cajero', async () => {
        prepararCajaAbierta(500);
        conDiscrepancia();
        prisma.permisos.findFirst.mockResolvedValue(null);

        const res: any = await service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR);

        expect(res).not.toHaveProperty('discrepanciaOffline');
      });

      it('solo cuenta tickets vivos y de origen offline', async () => {
        prepararCajaAbierta(500);
        conDiscrepancia();

        await service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR);

        expect(tx.ticket.aggregate.mock.calls[0][0].where).toMatchObject({
          anulado: false,
          origenOffline: true,
          montoRecalculado: { not: null },
        });
      });
    });

    it('calcula montoEsperado = inicial + ventas efectivo + donaciones', async () => {
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 1250 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 1750 }, EJECUTOR);

      // 500 + 1250 = 1750
      expect(cierre.montoEsperado!.toNumber()).toBe(1750);
      expect(cierre.diferencia!.toNumber()).toBe(0);
    });

    // Sin contarlas, cada donación aparecería como sobrante al cerrar.
    it('suma las donaciones en efectivo al monto esperado', async () => {
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 1250 } });
      tx.donacion.aggregate.mockResolvedValue({ _sum: { monto: 200 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 1950 }, EJECUTOR);

      // 500 + 1250 + 200 = 1950
      expect(cierre.montoEsperado!.toNumber()).toBe(1950);
      expect(cierre.diferencia!.toNumber()).toBe(0);
    });

    it('ignora las donaciones anuladas', async () => {
      prepararCajaAbierta(500);
      await service.cerrarCaja(1, { montoContado: 500 }, EJECUTOR);

      expect(tx.donacion.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ idAperturaCaja: 1, anulado: false }),
        }),
      );
    });

    it('reporta faltante cuando lo contado es menor a lo esperado', async () => {
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 1250 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 1740 }, EJECUTOR);

      expect(cierre.diferencia!.toNumber()).toBe(-10);
    });

    it('reporta sobrante cuando lo contado es mayor a lo esperado', async () => {
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 0 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 520 }, EJECUTOR);

      expect(cierre.diferencia!.toNumber()).toBe(20);
    });

    it('trata sumas nulas (sin ventas ni donaciones) como 0', async () => {
      prepararCajaAbierta(300);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: null } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 300 }, EJECUTOR);

      expect(cierre.montoEsperado!.toNumber()).toBe(300);
      expect(cierre.diferencia!.toNumber()).toBe(0);
    });

    it('mantiene exactitud decimal en el arqueo (sin error de punto flotante)', async () => {
      prepararCajaAbierta(0.1);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 0.2 } });

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

    // Si quien cuenta el efectivo viera el esperado, bastaría teclear esa cifra.
    it('NO revela montoEsperado ni diferencia a quien no supervisa', async () => {
      prisma.permisos.findFirst.mockResolvedValue(null); // sin Cajas.Editar
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 1250 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 1740 }, EJECUTOR);

      expect(cierre.montoEsperado).toBeUndefined();
      expect(cierre.diferencia).toBeUndefined();
      // Lo que el cajero sí debe ver: lo que él contó.
      expect(Number(cierre.montoFinal)).toBe(1740);
    });

    it('sí los revela a quien supervisa', async () => {
      prisma.permisos.findFirst.mockResolvedValue({ id: 1 }); // con Cajas.Editar
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 1250 } });

      const { cierre } = await service.cerrarCaja(1, { montoContado: 1740 }, EJECUTOR);

      expect(cierre.montoEsperado!.toNumber()).toBe(1750);
      expect(cierre.diferencia!.toNumber()).toBe(-10);
    });

    it('guarda el arqueo en la base aunque no se devuelva', async () => {
      prisma.permisos.findFirst.mockResolvedValue(null);
      prepararCajaAbierta(500);
      tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 1250 } });

      await service.cerrarCaja(1, { montoContado: 1740 }, EJECUTOR);

      // Ocultarlo es solo de cara al cliente: el dato queda registrado.
      const guardado = tx.cierreCaja.create.mock.calls[0][0].data;
      expect(guardado.montoEsperado.toNumber()).toBe(1750);
      expect(guardado.diferencia.toNumber()).toBe(-10);
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

    // Anularla dejaría esas ventas apuntando a una caja que no existe para el sistema.
    it('rechaza anular una apertura que ya tiene tickets', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        estado: { nombre: 'Abierta' },
      });
      tx.ticket.count.mockResolvedValue(3);

      await expect(service.anularApertura(1, EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.aperturaCaja.update).not.toHaveBeenCalled();
    });

    it('rechaza anular una apertura que ya tiene donaciones', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        estado: { nombre: 'Abierta' },
      });
      tx.donacion.count.mockResolvedValue(1);

      await expect(service.anularApertura(1, EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.aperturaCaja.update).not.toHaveBeenCalled();
    });

    // Los movimientos anulados ya salieron del arqueo, así que no bloquean.
    it('permite anular si los movimientos existentes están anulados', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        estado: { nombre: 'Abierta' },
      });
      tx.aperturaCaja.update.mockResolvedValue({ id: 1, anulado: true });

      await service.anularApertura(1, EJECUTOR);

      // El conteo filtra por anulado: false; si no hay activos, la anulación procede.
      expect(tx.ticket.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { idAperturaCaja: 1, anulado: false } }),
      );
      expect(tx.aperturaCaja.update).toHaveBeenCalled();
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
