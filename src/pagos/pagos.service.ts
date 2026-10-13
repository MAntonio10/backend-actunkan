import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const ESTADO_PAGO_PAGADO = 'PAGADO';
export const ESTADO_PAGO_PENDIENTE = 'PENDIENTE';
export const ESTADO_PAGO_CANCELADO = 'CANCELADO';

@Injectable()
export class PagosService {
  private readonly logger = new Logger(PagosService.name);

  // Ya no se inyecta `RecurrenteService`: este servicio dejó de preguntarle a la
  // pasarela. El estado lo escribe el webhook y acá solo se lee.
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Estado de un cobro, para la pantalla que ve quien acaba de pagar.
   *
   * Es SOLO LECTURA: no consulta a la pasarela y no escribe nada. Quien mueve el
   * estado es el webhook, y esto se limita a mirar lo que ya quedó escrito. Antes
   * acá vivía `confirmarCheckout`, que preguntaba a la pasarela y confirmaba el
   * cobro; eso hacía que un pago real se quedara sin confirmar para siempre si el
   * visitante no volvía a la página de éxito.
   *
   * La página sondea esto cada pocos segundos tras el pago y, en cuanto el webhook
   * entró, muestra el resultado. Normalmente son segundos.
   */
  async estadoDeCheckout(idCheckout: string) {
    const pago = await this.prisma.ticketPago.findFirst({
      where: { idPagoPasarela: idCheckout },
      orderBy: { id: 'desc' },
      include: {
        tickets: { select: { numeroTicket: true, anulado: true } },
      },
    });

    if (!pago) {
      // El id del checkout es opaco y lo tiene quien pagó, así que el 404 no filtra
      // nada. Devolver 200 con nulos dejaría la página sondeando para siempre.
      throw new NotFoundException(
        'No se encontró un pago asociado a ese checkout.',
      );
    }

    const anulado = pago.anulado || pago.tickets.anulado;

    return {
      // Se deriva de la fila en vez de dejar que lo decida quien llama: la base es
      // la única fuente de verdad y la página no tiene que comparar textos.
      pagado: pago.estadoPago === ESTADO_PAGO_PAGADO && !anulado,
      estadoPago:
        pago.estadoPago === ESTADO_PAGO_PENDIENTE
          ? 'Pago pendiente'
          : pago.estadoPago,
      monto: pago.monto.toString(),
      folio: pago.tickets.numeroTicket,
      fechaPago: pago.fechaPago,
      anulado,
    };
  }
  /** Consulta sin sincronizar, para pantallas internas. */
  async estadoPorTicket(idTicket: number) {
    const pagos = await this.prisma.ticketPago.findMany({
      where: { idTicket, anulado: false },
      include: { opcionPago: { select: { nombre: true, esEfectivo: true } } },
    });

    return pagos.map((p) => ({
      id: p.id,
      estadoPago:
        p.estadoPago === ESTADO_PAGO_PENDIENTE
          ? 'Pago pendiente'
          : p.estadoPago,
      monto: p.monto.toString(),
      opcionPago: p.opcionPago.nombre,
      checkoutUrl: p.checkoutUrl,
      idPagoPasarela: p.idPagoPasarela,
      fechaPago: p.fechaPago,
    }));
  }
}
