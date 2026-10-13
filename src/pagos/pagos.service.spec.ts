import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PagosService,
  ESTADO_PAGO_CANCELADO,
  ESTADO_PAGO_PAGADO,
  ESTADO_PAGO_PENDIENTE,
} from './pagos.service';

const CHECKOUT = 'ch_eegw9j5zgqoae3ms';

const pago = (extra: any = {}) => ({
  id: 5,
  estadoPago: ESTADO_PAGO_PENDIENTE,
  monto: new Prisma.Decimal(20),
  idPagoPasarela: CHECKOUT,
  anulado: false,
  fechaPago: null,
  tickets: {
    numeroTicket: 'TCK-2026-000054',
    anulado: false,
  },
  ...extra,
});

describe('PagosService', () => {
  let service: PagosService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      ticketPago: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
    };

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [PagosService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = modulo.get<PagosService>(PagosService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('estadoDeCheckout (público, solo lectura)', () => {
    /**
     * Lo que define este endpoint es lo que NO hace: no pregunta a la pasarela y no
     * escribe. Quien mueve el estado es el webhook. Si alguien vuelve a meter una
     * escritura acá, el estado tendría dos autores y volverían las carreras que la
     * guarda de transición del webhook está evitando.
     */
    it('no escribe nada', async () => {
      prisma.ticketPago.findFirst.mockResolvedValue(pago());

      await service.estadoDeCheckout(CHECKOUT);

      expect(prisma.ticketPago.update).toBeUndefined();
      expect(prisma.ticketPago.updateMany).toBeUndefined();
    });

    it('un pago pendiente se reporta sin pagar y con texto legible', async () => {
      prisma.ticketPago.findFirst.mockResolvedValue(pago());

      const res = await service.estadoDeCheckout(CHECKOUT);

      expect(res.pagado).toBe(false);
      expect(res.estadoPago).toBe('Pago pendiente');
      expect(res.folio).toBe('TCK-2026-000054');
      expect(res.monto).toBe('20');
    });

    it('un pago confirmado se reporta como pagado', async () => {
      const fechaPago = new Date('2026-10-06T14:32:11.000Z');
      prisma.ticketPago.findFirst.mockResolvedValue(
        pago({ estadoPago: ESTADO_PAGO_PAGADO, fechaPago }),
      );

      const res = await service.estadoDeCheckout(CHECKOUT);

      expect(res.pagado).toBe(true);
      expect(res.estadoPago).toBe('PAGADO');
      expect(res.fechaPago).toBe(fechaPago);
    });

    it('un cobro cancelado se reporta sin pagar y con su estado crudo', async () => {
      prisma.ticketPago.findFirst.mockResolvedValue(
        pago({ estadoPago: ESTADO_PAGO_CANCELADO }),
      );

      const res = await service.estadoDeCheckout(CHECKOUT);

      expect(res.pagado).toBe(false);
      expect(res.estadoPago).toBe('CANCELADO');
    });

    /**
     * Anular después de cobrar es un caso real: el dinero entró pero el pase ya no
     * vale, así que la página no puede decir «pago realizado exitosamente».
     */
    it.each([
      ['el pago está anulado', { anulado: true }],
      [
        'el ticket está anulado',
        { tickets: { numeroTicket: 'TCK-2026-000054', anulado: true } },
      ],
    ])('no se reporta pagado si %s', async (_caso, extra) => {
      prisma.ticketPago.findFirst.mockResolvedValue(
        pago({ estadoPago: ESTADO_PAGO_PAGADO, ...extra }),
      );

      const res = await service.estadoDeCheckout(CHECKOUT);

      expect(res.pagado).toBe(false);
      expect(res.anulado).toBe(true);
    });

    it('un checkout inexistente da 404', async () => {
      prisma.ticketPago.findFirst.mockResolvedValue(null);

      await expect(service.estadoDeCheckout(CHECKOUT)).rejects.toThrow(
        NotFoundException,
      );
    });

    /**
     * El endpoint es público: exponer el QR o la firma permitiría fabricar un pase,
     * y el nombre del grupo o cuántas personas son identifican a una persona ante
     * cualquiera que tenga el id del checkout.
     */
    it('no filtra el QR, la firma ni datos del visitante', async () => {
      prisma.ticketPago.findFirst.mockResolvedValue(
        pago({ estadoPago: ESTADO_PAGO_PAGADO }),
      );

      const res = await service.estadoDeCheckout(CHECKOUT);
      const plano = JSON.stringify(res);

      expect(plano).not.toMatch(
        /qrFirma|"qr"|nombre|atraccion|cantidadPersonas|checkoutUrl/,
      );
      expect(res.folio).toBe('TCK-2026-000054');
    });
  });

  describe('estadoPorTicket (interno)', () => {
    it('retorna "Pago pendiente" si no se ha confirmado', async () => {
      prisma.ticketPago.findMany.mockResolvedValue([
        {
          id: 1,
          estadoPago: ESTADO_PAGO_PENDIENTE,
          monto: new Prisma.Decimal(20),
          opcionPago: { nombre: 'Tarjeta', esEfectivo: false },
          checkoutUrl: 'https://checkout.url',
          idPagoPasarela: CHECKOUT,
          fechaPago: null,
        },
      ]);

      const res = await service.estadoPorTicket(1);

      expect(res[0].estadoPago).toBe('Pago pendiente');
    });
  });
});
