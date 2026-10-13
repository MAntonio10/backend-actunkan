import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { getFechaUTC6 } from '../common/utils/date.util';
import {
  ESTADO_PAGO_CANCELADO,
  ESTADO_PAGO_PAGADO,
  ESTADO_PAGO_PENDIENTE,
} from './pagos.service';

/** Módulo con el que se registra en bitácora, para no partir los filtros ya usados. */
const MODULO_BITACORA = 'EmisionTickets';

/** Autor visible en bitácora: no hay sesión detrás de un webhook. */
const AUTOR_BITACORA = 'Webhook Recurrente';

/** Moneda en la que se crean todos los checkouts (ver `recurrente.service.ts`). */
const MONEDA = 'GTQ';

/**
 * Qué se hizo con el evento. Viaja a `EventoPagoPasarela.resultado` y a la respuesta.
 */
export type ResultadoWebhook =
  | 'APLICADO'
  | 'DUPLICADO_IGNORADO'
  | 'IGNORADO_FUERA_DE_ORDEN'
  | 'IGNORADO_SIN_EFECTO'
  | 'IGNORADO_INCONSISTENTE'
  | 'CHECKOUT_DESCONOCIDO'
  | 'MONTO_DISCREPANTE'
  | 'TIPO_NO_SOPORTADO';

/**
 * Orden de los estados de un pago. Un evento solo puede MOVER HACIA ARRIBA.
 *
 * Es lo que vuelve inofensivo el desorden de entrega: la pasarela no garantiza que
 * los eventos lleguen en el orden en que ocurrieron, así que un `intent.pending`
 * rezagado puede aparecer después del `intent.succeeded` que confirmó el cobro. Sin
 * esta regla, ese rezagado devolvería el pago a pendiente y cerraría la puerta a
 * alguien que ya pagó.
 *
 * `PAGADO` es terminal. `CANCELADO` a `PAGADO` sí se permite: un segundo intento
 * exitoso sobre el mismo checkout es dinero que entró de verdad.
 */
const RANGO_ESTADO: Record<string, number> = {
  [ESTADO_PAGO_PENDIENTE]: 0,
  [ESTADO_PAGO_CANCELADO]: 1,
  [ESTADO_PAGO_PAGADO]: 2,
};

/** Estados del envelope que significan que el cobro se hizo. */
const ESTADOS_COBRADO = new Set(['succeeded', 'paid']);

/**
 * Si los eventos de fallo mueven el pago a `CANCELADO`.
 *
 * Nace en `true` y la bandera se queda como documentación del orden en que esto se
 * puede desplegar, porque el orden importa: la puerta rechazaba el ingreso solo
 * cuando encontraba un pago `PENDIENTE`, así que escribir `CANCELADO` sobre una
 * puerta sin endurecer habría sacado ese pago de la condición y **abierto la entrada
 * a un ticket sin cobrar**. Solo es seguro con la comprobación afirmativa de
 * `TicketsService.validar` ya en su lugar (exige al menos un pago `PAGADO` y ninguno
 * en otro estado).
 *
 * Si alguna vez hay que volver atrás en la puerta, hay que apagar esto primero.
 */
const ESCRIBIR_CANCELADO = true;

@Injectable()
export class WebhookRecurrenteService {
  private readonly logger = new Logger(WebhookRecurrenteService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Procesa un evento **ya verificado** y devuelve qué se hizo con él.
   *
   * No lanza por nada que sea culpa del contenido del evento: un checkout que no
   * conocemos, un tipo que no atendemos o un monto que no cuadra son resultados, no
   * errores. La razón es el reintento: la pasarela insiste hasta seis horas ante
   * cualquier respuesta que no sea 2xx, y ninguno de esos casos se arregla
   * reintentando. Solo se deja propagar un fallo de base, donde el reintento sí es
   * exactamente lo que se quiere.
   */
  async procesar(
    idEvento: string,
    evento: Record<string, any>,
    cuerpoCrudo: string,
  ): Promise<{ resultado: ResultadoWebhook }> {
    const tipoEvento = String(evento?.event_type ?? 'desconocido');
    const idCheckout = this.extraerIdCheckout(evento);

    try {
      return await this.prisma.$transaction(async (tx) =>
        this.procesarEnTransaccion(tx, {
          idEvento,
          tipoEvento,
          idCheckout,
          evento,
          cuerpoCrudo,
        }),
      );
    } catch (error) {
      // El `findUnique` de entrada es orientativo: dos entregas simultáneas del mismo
      // mensaje pueden pasarlo las dos. La unicidad de `idEvento` es la que decide, y
      // perder esa carrera significa que la otra entrega ya aplicó el evento.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.log(
          `Evento ${idEvento} ya estaba registrado (carrera de entregas): se ignora.`,
        );
        return { resultado: 'DUPLICADO_IGNORADO' };
      }
      throw error;
    }
  }

  private async procesarEnTransaccion(
    tx: any,
    datos: {
      idEvento: string;
      tipoEvento: string;
      idCheckout: string | null;
      evento: Record<string, any>;
      cuerpoCrudo: string;
    },
  ): Promise<{ resultado: ResultadoWebhook }> {
    const { idEvento, tipoEvento, idCheckout, evento, cuerpoCrudo } = datos;

    const yaRecibido = await tx.eventoPagoPasarela.findUnique({
      where: { idEvento },
    });

    if (yaRecibido) {
      this.logger.log(`Evento ${idEvento} ya procesado: se ignora.`);
      return { resultado: 'DUPLICADO_IGNORADO' };
    }

    const registrar = async (
      resultado: ResultadoWebhook,
      extra: { idTicketPago?: number; estadoResultante?: string } = {},
    ) => {
      await tx.eventoPagoPasarela.create({
        data: {
          idEvento,
          tipoEvento,
          idCheckout,
          idTicketPago: extra.idTicketPago ?? null,
          estadoResultante: extra.estadoResultante ?? null,
          resultado,
          cargaUtil: cuerpoCrudo,
          fechaRecepcion: getFechaUTC6(),
        },
      });
      return { resultado };
    };

    const destino = this.estadoDestino(tipoEvento, this.extraerEstado(evento));

    if (destino === 'INCONSISTENTE') {
      this.logger.warn(
        `Evento ${idEvento}: el tipo ${tipoEvento} llegó con status ` +
          `${String(evento?.status)}. No se escribe nada: un cobro no se marca ` +
          'sobre una contradicción.',
      );
      return registrar('IGNORADO_INCONSISTENTE');
    }

    if (destino === null) {
      return registrar('TIPO_NO_SOPORTADO');
    }

    if (destino === 'SIN_EFECTO') {
      return registrar('IGNORADO_SIN_EFECTO');
    }

    if (!idCheckout) {
      this.logger.warn(
        `Evento ${idEvento} sin checkout.id: no se puede emparejar con ningún pago.`,
      );
      return registrar('CHECKOUT_DESCONOCIDO');
    }

    // Se exige `anulado: false`: el pago de un ticket ya anulado no debe moverse.
    const pago = await tx.ticketPago.findFirst({
      where: { idPagoPasarela: idCheckout, anulado: false },
      orderBy: { id: 'desc' },
      include: { tickets: { select: { numeroTicket: true } } },
    });

    if (!pago) {
      // 200, nunca 404: acá caen los eventos de prueba, los de otro entorno y los de
      // un checkout creado por otro sistema con la misma cuenta. Ninguno se resuelve
      // reintentando durante seis horas.
      this.logger.warn(
        `Evento ${idEvento}: no hay pago vigente para el checkout ${idCheckout}.`,
      );
      return registrar('CHECKOUT_DESCONOCIDO');
    }

    const discrepancia = this.revisarMonto(evento, pago);

    if (discrepancia) {
      this.logger.error(
        `Evento ${idEvento}: ${discrepancia} El pago ${pago.id} se queda como está.`,
      );
      await BitacoraService.registrarEnTransaccion(tx, {
        usuarioNombre: AUTOR_BITACORA,
        accion: 'PAGO_MONTO_DISCREPANTE',
        modulo: MODULO_BITACORA,
        descripcion:
          `Webhook de pago rechazado para el ticket ${pago.tickets.numeroTicket} ` +
          `(checkout ${idCheckout}): ${discrepancia}`,
      });
      return registrar('MONTO_DISCREPANTE', { idTicketPago: pago.id });
    }

    const origenes = this.estadosOrigenPermitidos(destino);

    if (!origenes.includes(pago.estadoPago)) {
      this.logger.log(
        `Evento ${idEvento}: el pago ${pago.id} ya está en ${pago.estadoPago} y el ` +
          `evento pedía ${destino}. No se degrada.`,
      );
      return registrar('IGNORADO_FUERA_DE_ORDEN', { idTicketPago: pago.id });
    }

    const ahora = getFechaUTC6();

    // El predicado de estado va en el WHERE, no solo en la lectura de arriba: es lo
    // que hace que de dos entregas concurrentes escriba una sola. Si `count` es 0,
    // otra ya movió la fila mientras tanto.
    const { count } = await tx.ticketPago.updateMany({
      where: {
        id: pago.id,
        anulado: false,
        estadoPago: { in: origenes },
      },
      data: {
        estadoPago: destino,
        fechaActualizacion: ahora,
        ...(destino === ESTADO_PAGO_PAGADO ? { fechaPago: ahora } : {}),
        ...this.comprobante(evento),
      },
    });

    if (count !== 1) {
      this.logger.log(
        `Evento ${idEvento}: otra entrega ya movió el pago ${pago.id}. Se ignora.`,
      );
      return registrar('IGNORADO_FUERA_DE_ORDEN', { idTicketPago: pago.id });
    }

    await BitacoraService.registrarEnTransaccion(tx, {
      usuarioNombre: AUTOR_BITACORA,
      accion:
        destino === ESTADO_PAGO_PAGADO ? 'PAGO_CONFIRMADO' : 'PAGO_CANCELADO',
      modulo: MODULO_BITACORA,
      descripcion:
        (destino === ESTADO_PAGO_PAGADO
          ? `Pago con tarjeta confirmado por webhook para el ticket ${pago.tickets.numeroTicket}`
          : `Pago con tarjeta cancelado por webhook para el ticket ${pago.tickets.numeroTicket}`) +
        ` (checkout ${idCheckout}, ${pago.monto.toString()} ${MONEDA}, evento ${tipoEvento}).`,
    });

    return registrar('APLICADO', {
      idTicketPago: pago.id,
      estadoResultante: destino,
    });
  }

  /**
   * A qué estado lleva el evento, o por qué no lleva a ninguno.
   *
   * `event_type` y `status` tienen que coincidir. Son dos llaves de lo mismo y, si se
   * contradicen, el evento no se entiende: marcar un cobro sobre una contradicción es
   * la clase de error que se paga con entradas regaladas.
   */
  private estadoDestino(
    tipoEvento: string,
    status: unknown,
  ): string | 'SIN_EFECTO' | 'INCONSISTENTE' | null {
    const estado = String(status ?? '').toLowerCase();

    // Recurrente envía `payment_intent.succeeded`; el resto del código se escribió con
    // la forma corta `intent.*`, así que se aceptan las dos.
    const tipo = tipoEvento.replace(/^payment_intent\./, 'intent.');

    if (tipo === 'intent.succeeded' || tipo === 'intent.paid') {
      return ESTADOS_COBRADO.has(estado) ? ESTADO_PAGO_PAGADO : 'INCONSISTENTE';
    }

    if (tipo === 'intent.failed' || tipo === 'intent.canceled') {
      // El checkout de un intento fallido no queda en un estado de fallo propio (sigue
      // abierto para reintentar), así que no se exige uno. Lo que sí se rechaza es la
      // contradicción: un fallo sobre un checkout que dice estar pagado.
      if (ESTADOS_COBRADO.has(estado)) return 'INCONSISTENTE';
      return ESCRIBIR_CANCELADO ? ESTADO_PAGO_CANCELADO : 'SIN_EFECTO';
    }

    // La fila nace `PENDIENTE` en la emisión, así que este evento no aporta nada.
    if (tipo === 'intent.pending') return 'SIN_EFECTO';

    return null;
  }

  /** Desde qué estados se admite el salto, según el orden de `RANGO_ESTADO`. */
  private estadosOrigenPermitidos(destino: string): string[] {
    const rangoDestino = RANGO_ESTADO[destino] ?? -1;
    return Object.keys(RANGO_ESTADO).filter(
      (estado) => RANGO_ESTADO[estado] < rangoDestino,
    );
  }

  /**
   * Comprueba que el cobro sea por lo que se facturó.
   *
   * Devuelve el motivo si no cuadra, o `null` si está bien. Sin esto, un checkout
   * manipulado o reutilizado para otra venta dejaría pagar una fracción del total y
   * abrir la puerta igual.
   */
  private revisarMonto(
    evento: Record<string, any>,
    pago: { monto: Prisma.Decimal },
  ): string | null {
    const moneda = String(evento?.currency ?? MONEDA).toUpperCase();

    if (moneda !== MONEDA) {
      return `el cobro llegó en ${moneda} y el ticket se facturó en ${MONEDA}.`;
    }

    const centavos = evento?.amount_in_cents;
    if (centavos === undefined || centavos === null) return null;

    const cobrado = new Prisma.Decimal(centavos).div(100);

    if (!cobrado.equals(pago.monto)) {
      return (
        `se cobró ${cobrado.toString()} ${MONEDA} y el ticket exige ` +
        `${pago.monto.toString()}.`
      );
    }

    return null;
  }

  /**
   * Folio del recibo de la pasarela, si viene.
   *
   * `numeroComprobante` existía en el modelo sin que nadie lo escribiera. Guardarlo
   * no cambia ninguna lectura y es lo que permite cruzar un pago con el recibo de la
   * pasarela cuando una conciliación no cuadra.
   */
  private comprobante(evento: Record<string, any>) {
    const recibo = evento?.receipt_number;
    if (recibo === undefined || recibo === null) return {};
    return { numeroComprobante: String(recibo).slice(0, 100) };
  }

  /**
   * Estado del cobro. En los avisos reales de Recurrente no hay `status` en la raíz:
   * viene en `checkout.status` (`"paid"`).
   */
  private extraerEstado(evento: Record<string, any>): unknown {
    return evento?.status ?? evento?.checkout?.status;
  }

  /** `checkout.id` del cuerpo, que es lo que empareja con `idPagoPasarela`. */
  private extraerIdCheckout(evento: Record<string, any>): string | null {
    const id = evento?.checkout?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }
}
