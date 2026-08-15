import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { TicketsService } from './tickets.service';
import { firmarNumeroTicket } from '../common/utils/qr.util';
import { RecurrenteService } from '../pagos/recurrente.service';

const EJECUTOR = { id: 1, email: 'qa@test.com' };

const ATRACCION = { id: 1, codigo: 'cuevas', nombre: 'Cuevas Actun Kan', anulado: false };
const NACIONAL = { id: 1, codigo: 'nacional', nombre: 'Nacional', anulado: false };
const EXTRANJERO = { id: 2, codigo: 'extranjero', nombre: 'Extranjero', anulado: false };
const RECORRIDO = { id: 1, codigo: 'corto', nombre: 'Recorrido corto', anulado: false };
const EFECTIVO = { id: 1, nombre: 'Efectivo', esEfectivo: true, anulado: false };

const ADULTO = { id: 1, codigo: 'adulto', nombre: 'Adulto', anulado: false };
const NINO = { id: 2, codigo: 'nino', nombre: 'Niño (7 años o más)', anulado: false };
const NINO_MENOR = { id: 3, codigo: 'nino_menor', nombre: 'Niño menor de 7 años', anulado: false };
const CENTRO_EDUCATIVO = {
  id: 4,
  codigo: 'centro_educativo',
  nombre: 'Centro educativo',
  anulado: false,
};

/** Tabla de precios del documento: nacional 20/10/0/5, extranjero 25/25/0. */
const PRECIOS: Record<number, Record<number, number>> = {
  [NACIONAL.id]: { [ADULTO.id]: 20, [NINO.id]: 10, [CENTRO_EDUCATIVO.id]: 5 },
  [EXTRANJERO.id]: { [ADULTO.id]: 25, [NINO.id]: 25 },
};

const crearTxMock = () => {
  const tx: any = {
    aperturaCaja: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 9, anulado: false, estado: { nombre: 'Abierta' } }),
    },
    atraccion: { findUnique: jest.fn().mockResolvedValue(ATRACCION) },
    origenVisitante: { findUnique: jest.fn().mockResolvedValue(NACIONAL) },
    tipoRecorrido: { findUnique: jest.fn().mockResolvedValue(RECORRIDO) },
    opcionPago: { findUnique: jest.fn().mockResolvedValue(EFECTIVO) },
    pais: { findUnique: jest.fn().mockResolvedValue({ id: 50, nombre: 'España', anulado: false }) },
    tipoVisitante: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          [ADULTO, NINO, NINO_MENOR, CENTRO_EDUCATIVO].find((t) => t.id === where.id) ?? null,
        ),
      ),
    },
    tarifa: {
      findFirst: jest.fn(({ where }: any) => {
        const precio = PRECIOS[where.idOrigen]?.[where.idTipoVisitante];
        return Promise.resolve(precio === undefined ? null : { precio });
      }),
    },
    tarifaGuia: { findFirst: jest.fn().mockResolvedValue({ precio: 15 }) },
    // findFirst se usa para rechazar nombres de guía repetidos; sin coincidencia por defecto.
    guia: { findUnique: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    grupoEmision: { create: jest.fn().mockResolvedValue({ id: 100 }) },
    correlativoTicket: {
      upsert: jest.fn(),
    },
    ticket: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    ticketPago: { updateMany: jest.fn() },
    usuario: { findUnique: jest.fn().mockResolvedValue({ id: 1, nombre: 'QA Tester' }) },
  };

  // Correlativo: incrementa en cada llamada, como haría el upsert real.
  let contador = 0;
  tx.correlativoTicket.upsert.mockImplementation(() =>
    Promise.resolve({ ultimoNumero: ++contador }),
  );

  // Devuelve el ticket tal como se pidió crear, para poder inspeccionar montos y folio.
  tx.ticket.create.mockImplementation(({ data }: any) =>
    Promise.resolve({ id: 500 + contador, ...data }),
  );

  return tx;
};

describe('TicketsService', () => {
  let service: TicketsService;
  let tx: any;
  let prisma: any;
  let cajasService: any;
  let bitacoraService: any;
  let recurrente: any;

  beforeEach(async () => {
    tx = crearTxMock();
    prisma = {
      $transaction: jest.fn((cb: any) => cb(tx)),
      ticket: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
        aggregate: jest.fn(),
      },
    };
    cajasService = { obtenerActual: jest.fn().mockResolvedValue({ id: 9 }) };
    bitacoraService = { registrar: jest.fn().mockResolvedValue({}) };
    // Solo se invoca con formas de pago que no son efectivo.
    recurrente = {
      crearCheckout: jest.fn().mockResolvedValue({
        id: 'ch_prueba',
        status: 'unpaid',
        checkout_url: 'https://app.recurrente.com/checkout-session/ch_prueba',
      }),
      consultarCheckout: jest.fn(),
    };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CajasService, useValue: cajasService },
        { provide: BitacoraService, useValue: bitacoraService },
        { provide: RecurrenteService, useValue: recurrente },
      ],
    }).compile();

    service = modulo.get<TicketsService>(TicketsService);
  });

  afterEach(() => jest.restoreAllMocks());

  const dtoBase = (extra: any = {}) => ({
    nombreGrupo: 'QA-TEST-Familia',
    idAtraccion: ATRACCION.id,
    idOrigen: NACIONAL.id,
    idTipoRecorrido: RECORRIDO.id,
    idOpcionPago: EFECTIVO.id,
    cantidades: [{ idTipoVisitante: ADULTO.id, cantidad: 2 }],
    ...extra,
  });

  describe('cálculo de precios', () => {
    it('calcula 2 adultos + 3 niños nacionales = Q70', async () => {
      const res = await service.emitir(
        dtoBase({
          cantidades: [
            { idTipoVisitante: ADULTO.id, cantidad: 2 },
            { idTipoVisitante: NINO.id, cantidad: 3 },
          ],
        }),
        EJECUTOR,
      );

      expect(res.montoVisitantes).toBe('70'); // 2*20 + 3*10
      expect(res.tickets[0].cantidadPersonas).toBe(5);
    });

    it('aplica la tarifa de extranjero (2 adultos = Q50)', async () => {
      tx.origenVisitante.findUnique.mockResolvedValue(EXTRANJERO);

      const res = await service.emitir(
        dtoBase({ idOrigen: EXTRANJERO.id, idPais: 50 }),
        EJECUTOR,
      );

      expect(res.montoVisitantes).toBe('50');
    });

    it('cobra Q0 por el niño menor de 7 años sin consultar tarifa', async () => {
      const res = await service.emitir(
        dtoBase({
          cantidades: [
            { idTipoVisitante: ADULTO.id, cantidad: 1 },
            { idTipoVisitante: NINO_MENOR.id, cantidad: 4 },
          ],
        }),
        EJECUTOR,
      );

      expect(res.montoVisitantes).toBe('20'); // solo el adulto
      expect(res.tickets[0].cantidadPersonas).toBe(5);
    });

    it('guarda el precio unitario como snapshot en el desglose', async () => {
      await service.emitir(dtoBase(), EJECUTOR);

      const data = tx.ticket.create.mock.calls[0][0].data;
      const detalle = data.visitantePorTickets.create[0];
      expect(detalle.precioUnitario.toString()).toBe('20');
      expect(detalle.subtotal.toString()).toBe('40');
    });

    it('rechaza la venta si no hay tarifa vigente para la combinación', async () => {
      tx.tarifa.findFirst.mockResolvedValue(null);

      await expect(service.emitir(dtoBase(), EJECUTOR)).rejects.toThrow(BadRequestException);
    });
  });

  describe('pago con tarjeta', () => {
    const TARJETA = { id: 2, nombre: 'Tarjeta', esEfectivo: false, anulado: false };

    beforeEach(() => {
      tx.opcionPago.findUnique.mockResolvedValue(TARJETA);
    });

    it('genera el link de pago y deja el cobro PENDIENTE', async () => {
      const res = await service.emitir(dtoBase({ idOpcionPago: TARJETA.id }), EJECUTOR);

      const pago = tx.ticket.create.mock.calls[0][0].data.ticketPagos.create;
      expect(pago.estadoPago).toBe('PENDIENTE');
      expect(pago.idPagoPasarela).toBe('ch_prueba');
      expect(pago.checkoutUrl).toContain('checkout-session');
      expect(pago.fechaPago).toBeUndefined();
      expect(res.tickets[0].estadoPago).toBe('Pago pendiente');
    });

    it('envía el monto a la pasarela en centavos', async () => {
      await service.emitir(dtoBase({ idOpcionPago: TARJETA.id }), EJECUTOR);

      // 2 adultos x Q20 = Q40 -> 4000 centavos
      expect(recurrente.crearCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ montoEnCentavos: 4000 }),
      );
    });

    it('no registra la venta si la pasarela falla', async () => {
      recurrente.crearCheckout.mockRejectedValue(new Error('pasarela caída'));

      await expect(
        service.emitir(dtoBase({ idOpcionPago: TARJETA.id }), EJECUTOR),
      ).rejects.toThrow();

      expect(tx.ticket.create).not.toHaveBeenCalled();
    });

    it('el efectivo no toca la pasarela y queda PAGADO al instante', async () => {
      tx.opcionPago.findUnique.mockResolvedValue(EFECTIVO);

      const res = await service.emitir(dtoBase(), EJECUTOR);

      expect(recurrente.crearCheckout).not.toHaveBeenCalled();
      const pago = tx.ticket.create.mock.calls[0][0].data.ticketPagos.create;
      expect(pago.estadoPago).toBe('PAGADO');
      expect(pago.fechaPago).toBeDefined();
      expect(res.tickets[0].estadoPago).toBe('PAGADO');
    });
  });

  describe('reglas de negocio', () => {
    it('exige país cuando el origen es extranjero', async () => {
      tx.origenVisitante.findUnique.mockResolvedValue(EXTRANJERO);

      await expect(
        service.emitir(dtoBase({ idOrigen: EXTRANJERO.id }), EJECUTOR),
      ).rejects.toThrow(BadRequestException);
    });

    it('ignora el país cuando el origen es nacional', async () => {
      await service.emitir(dtoBase({ idPais: 50 }), EJECUTOR);

      expect(tx.ticket.create.mock.calls[0][0].data.idPais).toBeNull();
    });

    it('rechaza centro educativo para visitantes extranjeros', async () => {
      tx.origenVisitante.findUnique.mockResolvedValue(EXTRANJERO);

      await expect(
        service.emitir(
          dtoBase({
            idOrigen: EXTRANJERO.id,
            idPais: 50,
            cantidades: [{ idTipoVisitante: CENTRO_EDUCATIVO.id, cantidad: 1 }],
          }),
          EJECUTOR,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza emitir un ticket sin personas', async () => {
      await expect(
        service.emitir(
          dtoBase({ cantidades: [{ idTipoVisitante: ADULTO.id, cantidad: 0 }] }),
          EJECUTOR,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza emitir si no hay caja abierta', async () => {
      cajasService.obtenerActual.mockResolvedValue(null);

      await expect(service.emitir(dtoBase(), EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.ticket.create).not.toHaveBeenCalled();
    });

    it('rechaza emitir si la caja se cerró dentro de la transacción', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 9,
        anulado: false,
        estado: { nombre: 'Cerrada' },
      });

      await expect(service.emitir(dtoBase(), EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.ticket.create).not.toHaveBeenCalled();
    });
  });

  describe('guía acompañante', () => {
    it('emite un solo ticket cuando el guía tiene carnet', async () => {
      tx.guia.findUnique.mockResolvedValue({
        id: 7,
        nombre: 'Juan Tecún',
        tieneCarnet: true,
        anulado: false,
      });

      const res = await service.emitir(
        dtoBase({ guia: { modo: 'existente', idGuia: 7 } }),
        EJECUTOR,
      );

      expect(res.tickets).toHaveLength(1);
      expect(res.montoGuia).toBeNull();
      expect(res.montoTotalGeneral).toBe('40');
    });

    it('emite un segundo ticket de Q15 cuando el guía no tiene carnet', async () => {
      tx.guia.findUnique.mockResolvedValue({
        id: 8,
        nombre: "Pedro Ak'abal",
        tieneCarnet: false,
        anulado: false,
      });

      const res = await service.emitir(
        dtoBase({ guia: { modo: 'existente', idGuia: 8 } }),
        EJECUTOR,
      );

      expect(res.tickets).toHaveLength(2);
      expect(res.tickets[1].tipoTicket).toBe('GUIA');
      expect(res.tickets[1].cantidadPersonas).toBe(1);
      expect(res.montoGuia).toBe('15');
      expect(res.montoTotalGeneral).toBe('55'); // 40 visitantes + 15 guía
    });

    it('permite forma de pago distinta para el ticket del guía', async () => {
      tx.guia.findUnique.mockResolvedValue({ id: 8, nombre: 'X', tieneCarnet: false, anulado: false });
      const tarjeta = { id: 2, nombre: 'Tarjeta', esEfectivo: false, anulado: false };
      tx.opcionPago.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where.id === 2 ? tarjeta : EFECTIVO),
      );

      await service.emitir(
        dtoBase({ guia: { modo: 'existente', idGuia: 8, idOpcionPagoGuia: 2 } }),
        EJECUTOR,
      );

      const dataGuia = tx.ticket.create.mock.calls[1][0].data;
      expect(dataGuia.ticketPagos.create.idOpcionPago).toBe(2);
    });

    it('registra en el catálogo al guía nuevo', async () => {
      tx.guia.create.mockResolvedValue({
        id: 20,
        nombre: 'Guía Nuevo',
        tieneCarnet: false,
      });

      await service.emitir(
        dtoBase({ guia: { modo: 'nuevo', nombre: 'Guía Nuevo', tieneCarnet: false } }),
        EJECUTOR,
      );

      expect(tx.guia.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ nombre: 'Guía Nuevo', tieneCarnet: false }),
        }),
      );
    });

    it('rechaza con 409 un guía nuevo cuyo nombre ya existe', async () => {
      tx.guia.findFirst.mockResolvedValue({ id: 99, nombre: 'Carlos Garcia', anulado: false });

      await expect(
        service.emitir(
          dtoBase({ guia: { modo: 'nuevo', nombre: 'Carlos Garcia', tieneCarnet: false } }),
          EJECUTOR,
        ),
      ).rejects.toThrow(ConflictException);

      expect(tx.guia.create).not.toHaveBeenCalled();
      expect(tx.ticket.create).not.toHaveBeenCalled();
    });

    it('exige número de carnet cuando el guía nuevo dice tenerlo', async () => {
      await expect(
        service.emitir(
          dtoBase({ guia: { modo: 'nuevo', nombre: 'Sin número', tieneCarnet: true } }),
          EJECUTOR,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('folio y QR', () => {
    it('genera el folio como texto con la serie configurada', async () => {
      const anio = new Date().getFullYear();
      const res = await service.emitir(dtoBase(), EJECUTOR);

      expect(typeof res.tickets[0].numeroTicket).toBe('string');
      expect(res.tickets[0].numeroTicket).toBe(`TCK-${anio}-000001`);
    });

    it('no repite folio entre los dos tickets de una misma emisión', async () => {
      tx.guia.findUnique.mockResolvedValue({ id: 8, nombre: 'X', tieneCarnet: false, anulado: false });

      const res = await service.emitir(
        dtoBase({ guia: { modo: 'existente', idGuia: 8 } }),
        EJECUTOR,
      );

      expect(res.tickets[0].numeroTicket).not.toBe(res.tickets[1].numeroTicket);
    });

    it('firma el QR con el folio del propio ticket', async () => {
      const res = await service.emitir(dtoBase(), EJECUTOR);
      const ticket = res.tickets[0];

      expect(ticket.qrFirma).toBe(firmarNumeroTicket(ticket.numeroTicket));
      expect(JSON.parse(ticket.qr)).toEqual({
        numeroTicket: ticket.numeroTicket,
        firma: ticket.qrFirma,
      });
    });
  });

  describe('validar (control de acceso)', () => {
    const NUMERO = 'TCK-2026-000001';
    const FIRMA = firmarNumeroTicket(NUMERO);

    it('rechaza una firma alterada', async () => {
      await expect(
        service.validar({ numeroTicket: NUMERO, firma: 'firma-falsa' }, EJECUTOR),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
    });

    it('rechaza un ticket inexistente', async () => {
      prisma.ticket.findUnique.mockResolvedValue(null);

      await expect(service.validar({ numeroTicket: NUMERO, firma: FIRMA }, EJECUTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rechaza un ticket anulado', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 1, anulado: true, fechaUso: null });

      await expect(service.validar({ numeroTicket: NUMERO, firma: FIRMA }, EJECUTOR)).rejects.toThrow(
        ConflictException,
      );
    });

    it('acepta el primer uso y lo sella', async () => {
      prisma.ticket.findUnique.mockResolvedValue({ id: 1, anulado: false, fechaUso: null });
      prisma.ticket.update.mockResolvedValue({ id: 1, fechaUso: new Date() });

      const res = await service.validar({ numeroTicket: NUMERO, firma: FIRMA }, EJECUTOR);

      expect(res.valido).toBe(true);
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ idUsuarioUso: EJECUTOR.id }),
        }),
      );
    });

    // El QR existe desde que se genera el link: sin esto se entraría sin pagar.
    it('rechaza el ingreso si el pago con tarjeta sigue pendiente', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        fechaUso: null,
        ticketPagos: [{ anulado: false, estadoPago: 'PENDIENTE' }],
      });

      await expect(service.validar({ numeroTicket: NUMERO, firma: FIRMA }, EJECUTOR)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('permite el ingreso cuando el pago ya fue confirmado', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        fechaUso: null,
        ticketPagos: [{ anulado: false, estadoPago: 'PAGADO' }],
      });
      prisma.ticket.update.mockResolvedValue({ id: 1, fechaUso: new Date() });

      const res = await service.validar({ numeroTicket: NUMERO, firma: FIRMA }, EJECUTOR);
      expect(res.valido).toBe(true);
    });

    it('rechaza el reingreso de un ticket ya usado', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 1,
        anulado: false,
        fechaUso: new Date('2026-08-13T10:00:00Z'),
      });

      await expect(service.validar({ numeroTicket: NUMERO, firma: FIRMA }, EJECUTOR)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('deja rastro en bitácora de cada intento rechazado', async () => {
      await expect(
        service.validar({ numeroTicket: NUMERO, firma: 'mala' }, EJECUTOR),
      ).rejects.toThrow(UnauthorizedException);

      expect(bitacoraService.registrar).toHaveBeenCalledWith(
        expect.objectContaining({ accion: 'VALIDAR_TICKET', modulo: 'Tickets' }),
      );
    });
  });

  describe('anular', () => {
    it('anula el ticket y sus pagos para que salgan del arqueo', async () => {
      tx.ticket.findUnique.mockResolvedValue({
        id: 5,
        numeroTicket: 'TCK-2026-000005',
        anulado: false,
        idAperturaCaja: 9,
      });
      tx.ticket.update.mockResolvedValue({ id: 5, numeroTicket: 'TCK-2026-000005', anulado: true });

      await service.anular(5, EJECUTOR);

      expect(tx.ticketPago.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ anulado: true }) }),
      );
    });

    it('rechaza anular un ticket ya anulado', async () => {
      tx.ticket.findUnique.mockResolvedValue({
        id: 5,
        numeroTicket: 'TCK-2026-000005',
        anulado: true,
        idAperturaCaja: 9,
      });

      await expect(service.anular(5, EJECUTOR)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findOne y findAll', () => {
    it('findOne retorna estadoPago: "Pago pendiente" si tiene pago no confirmado', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 10,
        numeroTicket: 'TCK-2026-000010',
        qrFirma: 'firma10',
        anulado: false,
        ticketPagos: [{ anulado: false, estadoPago: 'PENDIENTE' }],
      });

      const res = await service.findOne(10);
      expect(res.estadoPago).toBe('Pago pendiente');
      expect(res.qr).toBeDefined();
    });

    it('findOne retorna estadoPago: "PAGADO" si el pago está confirmado', async () => {
      prisma.ticket.findUnique.mockResolvedValue({
        id: 10,
        numeroTicket: 'TCK-2026-000010',
        qrFirma: 'firma10',
        anulado: false,
        ticketPagos: [{ anulado: false, estadoPago: 'PAGADO' }],
      });

      const res = await service.findOne(10);
      expect(res.estadoPago).toBe('PAGADO');
    });

    it('findAll mapea estadoPago en cada ticket', async () => {
      prisma.ticket.findMany.mockResolvedValue([
        {
          id: 1,
          numeroTicket: 'TCK-2026-000001',
          qrFirma: 'firma1',
          anulado: false,
          ticketPagos: [{ anulado: false, estadoPago: 'PENDIENTE' }],
        },
        {
          id: 2,
          numeroTicket: 'TCK-2026-000002',
          qrFirma: 'firma2',
          anulado: false,
          ticketPagos: [{ anulado: false, estadoPago: 'PAGADO' }],
        },
      ]);
      prisma.ticket.count.mockResolvedValue(2);
      prisma.ticket.aggregate.mockResolvedValue({ _sum: { montoTotal: 100, cantidadPersonas: 4 } });

      const res = await service.findAll({});
      expect(res.datos[0].estadoPago).toBe('Pago pendiente');
      expect(res.datos[1].estadoPago).toBe('PAGADO');
    });
  });
});
