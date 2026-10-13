import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookRecurrenteService } from './webhook-recurrente.service';

/**
 * Prisma simulado al estilo de `offline.service.spec.ts`: `$transaction` ejecuta el
 * callback con un `tx` de espías, así que se puede afirmar sobre los argumentos
 * exactos de cada escritura sin tocar la base.
 */
function crearPrisma(opciones: {
  pago?: any;
  eventoPrevio?: any;
  filasActualizadas?: number;
  errorAlCrearEvento?: unknown;
}) {
  const tx = {
    eventoPagoPasarela: {
      findUnique: jest.fn().mockResolvedValue(opciones.eventoPrevio ?? null),
      create: jest.fn().mockImplementation(() => {
        if (opciones.errorAlCrearEvento) {
          return Promise.reject(opciones.errorAlCrearEvento);
        }
        return Promise.resolve({ id: 1 });
      }),
    },
    ticketPago: {
      findFirst: jest.fn().mockResolvedValue(opciones.pago ?? null),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opciones.filasActualizadas ?? 1 }),
    },
    bitacora: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  };

  return {
    tx,
    prisma: {
      $transaction: jest.fn((cb: any) => cb(tx)),
    } as unknown as PrismaService,
  };
}

const PAGO_PENDIENTE = {
  id: 7,
  estadoPago: 'PENDIENTE',
  monto: new Prisma.Decimal('150.0000'),
  tickets: { numeroTicket: 'TCK-2026-000054' },
};

const evento = (extra: Record<string, any> = {}) => ({
  type: 'payment',
  event_type: 'intent.succeeded',
  status: 'succeeded',
  receipt_number: 100482,
  amount_in_cents: 15000,
  currency: 'GTQ',
  checkout: { id: 'ch_abc123' },
  ...extra,
});

async function crearServicio(prisma: PrismaService) {
  const modulo = await Test.createTestingModule({
    providers: [
      WebhookRecurrenteService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();

  return modulo.get(WebhookRecurrenteService);
}

describe('WebhookRecurrenteService', () => {
  describe('cobro confirmado', () => {
    it('mueve el pago a PAGADO, sella la fecha y registra en bitácora', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar('msg_1', evento(), '{}');

      expect(res.resultado).toBe('APLICADO');

      const escritura = tx.ticketPago.updateMany.mock.calls[0][0];
      expect(escritura.data.estadoPago).toBe('PAGADO');
      expect(escritura.data.fechaPago).toBeInstanceOf(Date);
      // El folio del recibo de la pasarela, para poder conciliar después.
      expect(escritura.data.numeroComprobante).toBe('100482');
    });

    /**
     * El predicado de estado tiene que ir en el `WHERE`, no solo en la lectura
     * previa: es lo único que impide que dos entregas concurrentes escriban las dos.
     */
    it('condiciona la escritura al estado de origen y a que no esté anulado', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      await servicio.procesar('msg_1', evento(), '{}');

      const where = tx.ticketPago.updateMany.mock.calls[0][0].where;
      expect(where.id).toBe(7);
      expect(where.anulado).toBe(false);
      expect(where.estadoPago.in).toContain('PENDIENTE');
      expect(where.estadoPago.in).not.toContain('PAGADO');
    });

    it('escribe la bitácora dentro de la misma transacción', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      await servicio.procesar('msg_1', evento(), '{}');

      expect(tx.bitacora.create).toHaveBeenCalledTimes(1);
      const fila = tx.bitacora.create.mock.calls[0][0].data;
      expect(fila.accion).toBe('PAGO_CONFIRMADO');
      expect(fila.modulo).toBe('EmisionTickets');
      expect(fila.idUsuario).toBeNull();
      expect(fila.usuarioNombre).toBe('Webhook Recurrente');
    });

    it('solo busca pagos no anulados', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      await servicio.procesar('msg_1', evento(), '{}');

      expect(tx.ticketPago.findFirst.mock.calls[0][0].where).toEqual({
        idPagoPasarela: 'ch_abc123',
        anulado: false,
      });
    });

    it('acepta intent.paid igual que intent.succeeded', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ event_type: 'intent.paid', status: 'paid' }),
        '{}',
      );

      expect(res.resultado).toBe('APLICADO');
      expect(tx.ticketPago.updateMany).toHaveBeenCalled();
    });

    /**
     * El canal no decide: el checkout se crea solo con tarjeta, pero si algún día
     * llega un cobro por otra vía, el dinero entró igual. Negarse a confirmar un
     * cobro real es peor que aceptar uno cuyo canal sorprende.
     */
    it('aplica aunque el canal no sea tarjeta', async () => {
      const { prisma } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ type: 'bank_transfer' }),
        '{}',
      );

      expect(res.resultado).toBe('APLICADO');
    });
  });

  describe('idempotencia', () => {
    it('un evento ya registrado no vuelve a escribir', async () => {
      const { prisma, tx } = crearPrisma({
        pago: PAGO_PENDIENTE,
        eventoPrevio: { id: 1, idEvento: 'msg_1' },
      });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar('msg_1', evento(), '{}');

      expect(res.resultado).toBe('DUPLICADO_IGNORADO');
      expect(tx.ticketPago.updateMany).not.toHaveBeenCalled();
      expect(tx.eventoPagoPasarela.create).not.toHaveBeenCalled();
    });

    /**
     * La comprobación previa no basta bajo concurrencia: dos entregas simultáneas la
     * pasan las dos y la unicidad de `idEvento` decide. Perder esa carrera significa
     * que la otra ya aplicó el evento, no que algo falló.
     */
    it('la violación de unicidad se traduce a duplicado, no a error', async () => {
      const { prisma } = crearPrisma({
        pago: PAGO_PENDIENTE,
        errorAlCrearEvento: new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: '6.19.3' },
        ),
      });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar('msg_1', evento(), '{}');

      expect(res.resultado).toBe('DUPLICADO_IGNORADO');
    });

    it('un fallo de base sí se propaga, para que la pasarela reintente', async () => {
      const { prisma } = crearPrisma({
        pago: PAGO_PENDIENTE,
        errorAlCrearEvento: new Error('se cayó la conexión'),
      });
      const servicio = await crearServicio(prisma);

      await expect(servicio.procesar('msg_1', evento(), '{}')).rejects.toThrow(
        'se cayó la conexión',
      );
    });

    it('si otra entrega ya movió la fila, no se registra como aplicado', async () => {
      const { prisma } = crearPrisma({
        pago: PAGO_PENDIENTE,
        filasActualizadas: 0,
      });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar('msg_1', evento(), '{}');

      expect(res.resultado).toBe('IGNORADO_FUERA_DE_ORDEN');
    });
  });

  describe('orden de llegada', () => {
    it('un intent.pending rezagado no degrada un pago ya confirmado', async () => {
      const { prisma, tx } = crearPrisma({
        pago: { ...PAGO_PENDIENTE, estadoPago: 'PAGADO' },
      });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ event_type: 'intent.pending', status: 'pending' }),
        '{}',
      );

      expect(res.resultado).toBe('IGNORADO_SIN_EFECTO');
      expect(tx.ticketPago.updateMany).not.toHaveBeenCalled();
    });

    it('un fallo posterior no cancela un pago ya confirmado', async () => {
      const { prisma, tx } = crearPrisma({
        pago: { ...PAGO_PENDIENTE, estadoPago: 'PAGADO' },
      });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ event_type: 'intent.failed', status: 'failed' }),
        '{}',
      );

      expect(res.resultado).toBe('IGNORADO_FUERA_DE_ORDEN');
      expect(tx.ticketPago.updateMany).not.toHaveBeenCalled();
    });

    it('un fallo sobre un pago pendiente lo cancela', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ event_type: 'intent.canceled', status: 'canceled' }),
        '{}',
      );

      expect(res.resultado).toBe('APLICADO');
      const escritura = tx.ticketPago.updateMany.mock.calls[0][0].data;
      expect(escritura.estadoPago).toBe('CANCELADO');
      // Cancelar no sella fecha de pago: no hubo cobro.
      expect(escritura.fechaPago).toBeUndefined();
      expect(tx.bitacora.create.mock.calls[0][0].data.accion).toBe(
        'PAGO_CANCELADO',
      );
    });

    /** Un segundo intento exitoso sobre el mismo checkout es dinero que entró. */
    it('un cobro posterior a una cancelación sí se aplica', async () => {
      const { prisma } = crearPrisma({
        pago: { ...PAGO_PENDIENTE, estadoPago: 'CANCELADO' },
      });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar('msg_1', evento(), '{}');

      expect(res.resultado).toBe('APLICADO');
    });
  });

  describe('validación del monto', () => {
    it('no confirma si el cobro no coincide con lo facturado', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ amount_in_cents: 100 }),
        '{}',
      );

      expect(res.resultado).toBe('MONTO_DISCREPANTE');
      expect(tx.ticketPago.updateMany).not.toHaveBeenCalled();
      // Queda registrado: es lo que permite resolverlo a mano.
      expect(tx.bitacora.create.mock.calls[0][0].data.accion).toBe(
        'PAGO_MONTO_DISCREPANTE',
      );
    });

    it('no confirma si el cobro llegó en otra moneda', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ currency: 'USD' }),
        '{}',
      );

      expect(res.resultado).toBe('MONTO_DISCREPANTE');
      expect(tx.ticketPago.updateMany).not.toHaveBeenCalled();
    });

    /** `150` y `150.0000` son el mismo dinero: se compara valor, no representación. */
    it('acepta el mismo valor con otra escala decimal', async () => {
      const { prisma } = crearPrisma({
        pago: { ...PAGO_PENDIENTE, monto: new Prisma.Decimal('150') },
      });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar('msg_1', evento(), '{}');

      expect(res.resultado).toBe('APLICADO');
    });
  });

  describe('eventos que no se aplican', () => {
    it('un checkout que no existe se acepta sin escribir', async () => {
      const { prisma, tx } = crearPrisma({ pago: null });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar('msg_1', evento(), '{}');

      expect(res.resultado).toBe('CHECKOUT_DESCONOCIDO');
      expect(tx.ticketPago.updateMany).not.toHaveBeenCalled();
      // Se guarda igual: es la evidencia de qué llegó.
      expect(tx.eventoPagoPasarela.create).toHaveBeenCalled();
    });

    it('un evento sin checkout.id no se intenta emparejar', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ checkout: undefined }),
        '{}',
      );

      expect(res.resultado).toBe('CHECKOUT_DESCONOCIDO');
      expect(tx.ticketPago.findFirst).not.toHaveBeenCalled();
    });

    it('un tipo de evento que no atendemos se acepta y se archiva', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ event_type: 'subscription.create', status: 'succeeded' }),
        '{}',
      );

      expect(res.resultado).toBe('TIPO_NO_SOPORTADO');
      expect(tx.ticketPago.updateMany).not.toHaveBeenCalled();
    });

    /**
     * `event_type` y `status` son dos llaves de lo mismo. Si se contradicen, el
     * evento no se entiende, y marcar un cobro sobre una contradicción es la clase de
     * error que se paga con entradas regaladas.
     */
    it('no confirma si event_type y status se contradicen', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);

      const res = await servicio.procesar(
        'msg_1',
        evento({ event_type: 'intent.succeeded', status: 'failed' }),
        '{}',
      );

      expect(res.resultado).toBe('IGNORADO_INCONSISTENTE');
      expect(tx.ticketPago.updateMany).not.toHaveBeenCalled();
    });

    it('guarda el cuerpo crudo como evidencia', async () => {
      const { prisma, tx } = crearPrisma({ pago: PAGO_PENDIENTE });
      const servicio = await crearServicio(prisma);
      const crudo = JSON.stringify(evento());

      await servicio.procesar('msg_1', evento(), crudo);

      const fila = tx.eventoPagoPasarela.create.mock.calls[0][0].data;
      expect(fila.cargaUtil).toBe(crudo);
      expect(fila.idEvento).toBe('msg_1');
      expect(fila.resultado).toBe('APLICADO');
      expect(fila.estadoResultante).toBe('PAGADO');
      expect(fila.idTicketPago).toBe(7);
    });
  });
});
