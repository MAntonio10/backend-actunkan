import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/** Estados que devuelve Recurrente. Solo `paid` cuenta como cobrado. */
export const ESTADO_PASARELA_PAGADO = 'paid';

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
  payment_method?: { type?: string; card?: { last4?: string; network?: string } };
}

@Injectable()
export class RecurrenteService {
  private readonly logger = new Logger(RecurrenteService.name);

  private get baseUrl(): string {
    return (process.env.RECURRENTE_API_URL || 'https://app.recurrente.com/api').replace(/\/$/, '');
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
      this.logger.error(`Fallo de red con la pasarela (${url}): ${error.message}`);
      throw new ServiceUnavailableException(
        'No se pudo contactar a la pasarela de pago. Intente de nuevo o cobre por otro medio.',
      );
    }

    const texto = await respuesta.text();

    if (!respuesta.ok) {
      this.logger.error(`Pasarela respondió ${respuesta.status} en ${ruta}: ${texto.slice(0, 300)}`);
      throw new ServiceUnavailableException(
        `La pasarela de pago rechazó la solicitud (${respuesta.status}).`,
      );
    }

    try {
      return JSON.parse(texto) as T;
    } catch {
      this.logger.error(`Respuesta no-JSON de la pasarela en ${ruta}: ${texto.slice(0, 200)}`);
      throw new ServiceUnavailableException('La pasarela de pago devolvió una respuesta inválida.');
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
    };

    const checkout = await this.pedir<CheckoutCreado>('/checkouts', {
      method: 'POST',
      body: JSON.stringify(cuerpo),
    });

    this.logger.log(`Checkout creado ${checkout.id} por ${params.montoEnCentavos} centavos.`);
    return checkout;
  }

  /**
   * Consulta el estado real del checkout. Es la única fuente de verdad: el cliente
   * nunca decide si pagó, aunque llegue a la página de éxito.
   */
  async consultarCheckout(idCheckout: string): Promise<CheckoutConsultado> {
    return this.pedir<CheckoutConsultado>(`/checkouts/${encodeURIComponent(idCheckout)}`);
  }
}
