import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

/** Estados que devuelve Recurrente. Solo `paid` cuenta como cobrado. */
export const ESTADO_PASARELA_PAGADO = 'paid';

/**
 * Cuánto vive un link de pago antes de vencer.
 *
 * Dos horas: el cobro con tarjeta es en taquilla, y un link que sigue vivo al día
 * siguiente es un pago que entraría a una caja que ya cuadró. Al vencer, la pasarela
 * rechaza la URL y el `TicketPago` se queda `PENDIENTE`, que es correcto: la puerta
 * sigue cerrada y el arqueo de efectivo no se ve afectado, porque solo suma los
 * pagos `PAGADO` en efectivo.
 */
export const VIGENCIA_CHECKOUT_MS = 2 * 60 * 60 * 1000;

export interface CheckoutCreado {
  id: string;
  status: string;
  checkout_url: string;
}

export interface CheckoutConsultado {
  id: string;
  status: string;
  total_in_cents?: number;
  currency?: string;
  payment_method?: {
    type?: string;
    card?: { last4?: string; network?: string };
  };
}

@Injectable()
export class RecurrenteService {
  private readonly logger = new Logger(RecurrenteService.name);

  private get baseUrl(): string {
    return (
      process.env.RECURRENTE_API_URL || 'https://app.recurrente.com/api'
    ).replace(/\/$/, '');
  }

  private get secreto(): string {
    const key = process.env.RECURRENTE_SECRET_KEY;
    if (!key) {
      // Falla explícita: sin llave no hay forma de cobrar con tarjeta.
      throw new ServiceUnavailableException(
        'La pasarela de pago no está configurada (falta RECURRENTE_SECRET_KEY).',
      );
    }
    return key;
  }

  /** ¿Está configurada la pasarela? Permite seguir vendiendo en efectivo si no lo está. */
  get estaConfigurada(): boolean {
    return Boolean(process.env.RECURRENTE_SECRET_KEY);
  }

  private async pedir<T>(ruta: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${ruta}`;

    let respuesta: Response;
    try {
      respuesta = await fetch(url, {
        ...init,
        headers: {
          'X-SECRET-KEY': this.secreto,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
        // Una taquilla no puede quedarse colgada esperando a la pasarela.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error: any) {
      this.logger.error(
        `Fallo de red con la pasarela (${url}): ${error.message}`,
      );
      throw new ServiceUnavailableException(
        'No se pudo contactar a la pasarela de pago. Intente de nuevo o cobre por otro medio.',
      );
    }

    const texto = await respuesta.text();

    if (!respuesta.ok) {
      this.logger.error(
        `Pasarela respondió ${respuesta.status} en ${ruta}: ${texto.slice(0, 300)}`,
      );
      throw new ServiceUnavailableException(
        `La pasarela de pago rechazó la solicitud (${respuesta.status}).`,
      );
    }

    try {
      return JSON.parse(texto) as T;
    } catch {
      this.logger.error(
        `Respuesta no-JSON de la pasarela en ${ruta}: ${texto.slice(0, 200)}`,
      );
      throw new ServiceUnavailableException(
        'La pasarela de pago devolvió una respuesta inválida.',
      );
    }
  }

  /**
   * Crea un checkout y devuelve el `checkout_url`: ese es el link de pago que se
   * copia y se envía al cliente por correo o WhatsApp.
   */
  async crearCheckout(params: {
    concepto: string;
    montoEnCentavos: number;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutCreado> {
    const cuerpo = {
      items: [
        {
          name: params.concepto,
          currency: 'GTQ',
          amount_in_cents: params.montoEnCentavos,
          custom_payment_method_settings: 'true',
          card_payments_enabled: 'true',
          bank_transfer_payments_enabled: 'false',
          available_installments: [],
          billing_info_requirement: 'none',
          quantity: 1,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      // Vence a las dos horas: pensado para el pago en el acto, en taquilla, y para
      // que un link viejo no se pague contra una caja ya cerrada.
      //
      // OJO CON LA FECHA: esto es un INSTANTE REAL y no la convención de la base.
      // `getFechaUTC6()` devuelve el reloj de pared de Guatemala —epoch corrido seis
      // horas— porque es lo que se guarda en las columnas. Usarla acá enviaría
      // `ahora + 2h - 6h`, o sea cuatro horas en el pasado: la pasarela daría el
      // checkout por vencido en el acto y el taquillero vería un 503 sin ninguna
      // pista de por qué.
      expires_at: new Date(Date.now() + VIGENCIA_CHECKOUT_MS).toISOString(),
    };

    const checkout = await this.pedir<CheckoutCreado>('/checkouts', {
      method: 'POST',
      body: JSON.stringify(cuerpo),
    });

    this.logger.log(
      `Checkout creado ${checkout.id} por ${params.montoEnCentavos} centavos.`,
    );
    return checkout;
  }

  /**
   * Consulta el estado real del checkout. Es la única fuente de verdad: el cliente
   * nunca decide si pagó, aunque llegue a la página de éxito.
   */
  async consultarCheckout(idCheckout: string): Promise<CheckoutConsultado> {
    return this.pedir<CheckoutConsultado>(
      `/checkouts/${encodeURIComponent(idCheckout)}`,
    );
  }
}
