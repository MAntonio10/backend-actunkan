import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { getFechaUTC6 } from '../common/utils/date.util';
import { ESTADO_PASARELA_PAGADO, RecurrenteService } from './recurrente.service';

export const ESTADO_PAGO_PAGADO = 'PAGADO';
export const ESTADO_PAGO_PENDIENTE = 'PENDIENTE';
export const ESTADO_PAGO_CANCELADO = 'CANCELADO';

@Injectable()
export class PagosService {
  private readonly logger = new Logger(PagosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recurrente: RecurrenteService,
  ) {}

  /**
   * Sincroniza el estado del pago consultando a la pasarela.
   *
   * Lo llama la página pública de éxito cuando la pasarela redirige de vuelta.
   * El estado nunca se toma de lo que diga el cliente: se pregunta a Recurrente
   * con la llave secreta, y solo `paid` marca el pago como cobrado.
   */
  async confirmarCheckout(idCheckout: string) {
    const pago = await this.prisma.ticketPago.findFirst({
      where: { idPagoPasarela: idCheckout },
      include: {
        tickets: {
          select: {
            id: true,
            numeroTicket: true,
            nombre: true,
            cantidadPersonas: true,
            anulado: true,
            atraccion: { select: { nombre: true } },
          },
        },
      },
    });

    if (!pago) {
      throw new NotFoundException('No se encontró un pago asociado a ese checkout.');
    }

    // Ya estaba resuelto: se responde sin volver a consultar a la pasarela.
    if (pago.estadoPago === ESTADO_PAGO_PAGADO) {
      return this.respuestaPublica(pago, true);
    }

    const checkout = await this.recurrente.consultarCheckout(idCheckout);
    const pagado = checkout.status === ESTADO_PASARELA_PAGADO;

    if (!pagado) {
      this.logger.log(`Checkout ${idCheckout} sigue en estado '${checkout.status}'.`);
      return this.respuestaPublica(pago, false, checkout.status);
    }

    const ahora = getFechaUTC6();
    const actualizado = await this.prisma.ticketPago.update({
      where: { id: pago.id },
      data: {
        estadoPago: ESTADO_PAGO_PAGADO,
        fechaPago: ahora,
        fechaActualizacion: ahora,
      },
      include: { tickets: { select: { numeroTicket: true } } },
    });

    await BitacoraService.registrarEnTransaccion(this.prisma, {
      accion: 'PAGO_CONFIRMADO',
      modulo: 'EmisionTickets',
      descripcion:
        `Pago con tarjeta confirmado para el ticket ${actualizado.tickets.numeroTicket} ` +
        `(checkout ${idCheckout}, ${pago.monto.toString()} GTQ).`,
    });

    this.logger.log(`Pago confirmado para el ticket ${actualizado.tickets.numeroTicket}.`);

    return this.respuestaPublica({ ...pago, estadoPago: ESTADO_PAGO_PAGADO }, true);
  }

  /**
   * Lo mínimo que necesita la página de éxito. El endpoint es público, así que no
   * se expone el QR ni la firma: con eso cualquiera podría fabricarse un pase.
   */
  private respuestaPublica(pago: any, pagado: boolean, estadoPasarela?: string) {
    const estadoPago = pagado
      ? ESTADO_PAGO_PAGADO
      : pago.estadoPago === ESTADO_PAGO_PENDIENTE
      ? 'Pago pendiente'
      : pago.estadoPago;

    return {
      pagado,
      estadoPago,
      ...(estadoPasarela ? { estadoPasarela } : {}),
      monto: pago.monto.toString(),
      ticket: {
        numeroTicket: pago.tickets.numeroTicket,
        nombre: pago.tickets.nombre,
        cantidadPersonas: pago.tickets.cantidadPersonas,
        atraccion: pago.tickets.atraccion?.nombre ?? null,
        anulado: pago.tickets.anulado,
      },
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
      estadoPago: p.estadoPago === ESTADO_PAGO_PENDIENTE ? 'Pago pendiente' : p.estadoPago,
      monto: p.monto.toString(),
      opcionPago: p.opcionPago.nombre,
      checkoutUrl: p.checkoutUrl,
      idPagoPasarela: p.idPagoPasarela,
      fechaPago: p.fechaPago,
    }));
  }
}
