import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
// `import type`: el tipo aparece en una firma decorada y, con `emitDecoratorMetadata`,
// TypeScript exige que no sea una importación de valor (TS1272).
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { VerificadorWebhookService } from './verificador-webhook.service';
import { WebhookRecurrenteService } from './webhook-recurrente.service';

/**
 * Entrada de los avisos de cobro de la pasarela.
 *
 * Va en `webhooks/` y no bajo `pagos/` a propósito: esta URL queda registrada en la
 * pasarela y cambiarla después obliga a volver a registrar el endpoint y a rotar el
 * secreto, así que no conviene atarla al nombre de un recurso de negocio que puede
 * renombrarse.
 */
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly verificador: VerificadorWebhookService,
    private readonly webhooks: WebhookRecurrenteService,
  ) {}

  /**
   * Recibe un evento de pago de Recurrente.
   *
   * `@Public()` porque quien llama es la pasarela y no tiene sesión; la firma es la
   * autenticación. El `@Throttle` propio existe porque el `ThrottlerGuard` global no
   * sabe de `@Public()` y aplicaría el techo de 120/min a entregas legítimas que
   * llegan todas desde las mismas IP; 300/min no toca tráfico real pero deja un
   * límite en un endpoint sin credenciales.
   *
   * SOBRE LOS CÓDIGOS DE RESPUESTA
   * ------------------------------
   * La pasarela reintenta hasta seis horas ante cualquier respuesta que no sea 2xx.
   * Por eso un evento que no podemos aplicar —checkout desconocido, tipo que no
   * atendemos, monto que no cuadra— responde **200**: reintentarlo no lo arreglaría
   * y solo llenaría el log. Se reserva el no-2xx para lo que un reintento sí puede
   * salvar: firma inválida (401, da margen a corregir el secreto), falta de secreto
   * (503) y fallo de base (500, que se deja propagar).
   *
   * No se declara `@Body()` con un DTO: el `ValidationPipe` global tiene
   * `forbidNonWhitelisted`, así que rechazaría con 400 cualquier campo nuevo del
   * payload —y la pasarela versiona su contrato—, y además la firma hay que
   * comprobarla sobre los bytes exactos que llegaron, no sobre un objeto que Express
   * ya interpretó y volvería a serializar distinto.
   */
  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('recurrente')
  async recurrente(@Req() req: RawBodyRequest<Request>) {
    const cuerpoCrudo = req.rawBody;

    if (!cuerpoCrudo || cuerpoCrudo.length === 0) {
      // Pasa cuando el `content-type` no es JSON y el parser no guardó el crudo.
      // Es 400 y no 200 porque sin cuerpo no hay nada que procesar, y reintentar
      // con las cabeceras correctas sí puede funcionar.
      throw new BadRequestException(
        'El webhook llegó sin cuerpo utilizable. Envíelo con content-type application/json.',
      );
    }

    const evento = this.verificador.verificar(cuerpoCrudo, req.headers);

    // El `svix-id` identifica el MENSAJE y es estable entre reintentos del mismo, así
    // que es la llave de deduplicación. La firma ya se verificó, de modo que acá la
    // cabecera es un dato de confianza.
    const idEvento = String(req.headers['svix-id'] ?? '');

    if (!idEvento) {
      throw new BadRequestException('Falta la cabecera svix-id.');
    }

    const { resultado } = await this.webhooks.procesar(
      idEvento,
      evento,
      cuerpoCrudo.toString('utf8'),
    );

    this.logger.log(
      `Webhook ${evento?.event_type ?? 'desconocido'} (${idEvento}): ${resultado}.`,
    );

    return { recibido: true, resultado };
  }
}
