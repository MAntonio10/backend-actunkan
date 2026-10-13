import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { PagosService } from './pagos.service';
import { RecurrenteService } from './recurrente.service';
import { PagosController } from './pagos.controller';
import { WebhooksController } from './webhooks.controller';
import { WebhookRecurrenteService } from './webhook-recurrente.service';
import {
  SECRETO_WEBHOOK_RECURRENTE,
  VerificadorWebhookService,
} from './verificador-webhook.service';

@Module({
  controllers: [PagosController, WebhooksController],
  providers: [
    PagosService,
    RecurrenteService,
    WebhookRecurrenteService,
    VerificadorWebhookService,
    {
      /**
       * El secreto se inyecta en vez de leerse con `process.env` dentro del servicio,
       * para que las pruebas puedan pasar uno propio sin tocar el entorno.
       *
       * Se permite que falte: el sistema arranca igual y lo único que queda cerrado
       * es el webhook, que responde 503. El fail-fast de `JWT_SECRET` no sirve acá
       * porque impediría arrancar el sistema entero hasta tener el secreto, y hasta
       * entonces hay que poder seguir vendiendo en efectivo. Lo que no pasa nunca es
       * procesar un evento sin verificar la firma.
       */
      provide: SECRETO_WEBHOOK_RECURRENTE,
      useValue: process.env.RECURRENTE_WEBHOOK_SECRET ?? '',
    },
  ],
  exports: [PagosService, RecurrenteService],
})
export class PagosModule implements OnModuleInit {
  private readonly logger = new Logger(PagosModule.name);

  constructor(private readonly verificador: VerificadorWebhookService) {}

  /**
   * Avisa al arrancar si los pagos con tarjeta no se van a poder confirmar.
   *
   * Sin esto, la falta del secreto solo se descubre cuando un visitante ya pagó y su
   * pase no abre la puerta.
   */
  onModuleInit() {
    if (this.verificador.estaConfigurado) {
      this.logger.log(
        'Webhooks de pago habilitados en POST /webhooks/recurrente.',
      );
      return;
    }

    this.logger.warn(
      'Webhooks de pago DESHABILITADOS: falta RECURRENTE_WEBHOOK_SECRET. ' +
        'Los cobros con tarjeta quedarán en PENDIENTE y no abrirán la puerta.',
    );
  }
}
