import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { RecurrenteService } from './recurrente.service';
import { PagosService, ESTADO_PAGO_PAGADO, ESTADO_PAGO_PENDIENTE } from './pagos.service';

const CHECKOUT = 'ch_eegw9j5zgqoae3ms';

const pagoPendiente = (extra: any = {}) => ({
  id: 5,
  estadoPago: ESTADO_PAGO_PENDIENTE,
  monto: new Prisma.Decimal(20),
  idPagoPasarela: CHECKOUT,
  tickets: {
    id: 1,
    numeroTicket: 'TCK-2026-000054',
    nombre: 'Manuel Castellanos',
    cantidadPersonas: 1,
    anulado: false,
    atraccion: { nombre: 'Biblioteca ambiental' },
  },
  ...extra,
});

describe('PagosService', () => {
  let service: PagosService;
  let prisma: any;
  let recurrente: any;

  beforeEach(async () => {
    prisma = {
      ticketPago: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(({ data }: any) =>
          Promise.resolve({ ...pagoPendiente(), ...data, tickets: { numeroTicket: 'TCK-2026-000054' } }),
        ),
      },
      bitacora: { create: jest.fn() },
    };
    recurrente = { consultarCheckout: jest.fn() };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        PagosService,
        { provide: PrismaService, useValue: prisma },
        { provide: RecurrenteService, useValue: recurrente },
      ],
    }).compile();

    service = modulo.get<PagosService>(PagosService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('marca el pago como PAGADO solo si la pasarela dice "paid"', async () => {
    prisma.ticketPago.findFirst.mockResolvedValue(pagoPendiente());
    recurrente.consultarCheckout.mockResolvedValue({ id: CHECKOUT, status: 'paid' });

    const res = await service.confirmarCheckout(CHECKOUT);

    expect(res.pagado).toBe(true);
    expect(res.estadoPago).toBe(ESTADO_PAGO_PAGADO);
    expect(prisma.ticketPago.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ estadoPago: ESTADO_PAGO_PAGADO }),
      }),
    );
  });

  // Cualquier estado distinto de 'paid' deja el pago pendiente.
  it.each(['unpaid', 'pending', 'expired', 'failed'])(
    'NO marca como pagado si la pasarela dice "%s"',
    async (estado) => {
      prisma.ticketPago.findFirst.mockResolvedValue(pagoPendiente());
      recurrente.consultarCheckout.mockResolvedValue({ id: CHECKOUT, status: estado });

      const res = await service.confirmarCheckout(CHECKOUT);

      expect(res.pagado).toBe(false);
      expect(res.estadoPago).toBe('Pago pendiente');
      expect(res.estadoPasarela).toBe(estado);
      expect(prisma.ticketPago.update).not.toHaveBeenCalled();
    },
  );

  it('no vuelve a consultar la pasarela si el pago ya estaba confirmado', async () => {
    prisma.ticketPago.findFirst.mockResolvedValue(
      pagoPendiente({ estadoPago: ESTADO_PAGO_PAGADO }),
    );

    const res = await service.confirmarCheckout(CHECKOUT);

    expect(res.pagado).toBe(true);
    expect(res.estadoPago).toBe(ESTADO_PAGO_PAGADO);
    expect(recurrente.consultarCheckout).not.toHaveBeenCalled();
  });

  it('rechaza un checkout desconocido', async () => {
    prisma.ticketPago.findFirst.mockResolvedValue(null);

    await expect(service.confirmarCheckout('ch_inventado')).rejects.toThrow(NotFoundException);
  });

  // El endpoint es público: exponer el QR o su firma permitiría fabricar un pase.
  it('la respuesta pública no incluye el QR ni la firma', async () => {
    prisma.ticketPago.findFirst.mockResolvedValue(pagoPendiente());
    recurrente.consultarCheckout.mockResolvedValue({ id: CHECKOUT, status: 'paid' });

    const res: any = await service.confirmarCheckout(CHECKOUT);
    const plano = JSON.stringify(res);

    expect(plano).not.toMatch(/qrFirma|"qr"/);
    expect(res.ticket.numeroTicket).toBe('TCK-2026-000054');
  });

  it('estadoPorTicket retorna "Pago pendiente" si no se ha confirmado', async () => {
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
