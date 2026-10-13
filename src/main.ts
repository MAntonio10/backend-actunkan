import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import {
  esProduccion,
  origenesCors,
  problemasDeDespliegue,
  urlAplicacion,
  urlExito,
  urlWebhook,
} from './common/utils/urls.util';

async function bootstrap() {
  const logger = new Logger('Arranque');

  // `rawBody` deja disponible `req.rawBody` con los bytes exactos que llegaron.
  // Lo necesita la verificación de firma de los webhooks de pago: el HMAC se calcula
  // sobre esos bytes, así que validarlo contra un JSON reserializado por Express
  // falla aunque el contenido sea idéntico —basta que cambie el orden de una clave
  // o el escapado de un carácter—. Ver `src/pagos/verificador-webhook.service.ts`.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Detrás de un proxy inverso (nginx, balanceador, Cloudflare) todas las peticiones
  // llegan con la IP del proxy: sin esto el límite por IP sería uno solo compartido
  // por todos los usuarios y bastaría un cliente activo para bloquear al resto.
  // Actívelo SOLO si hay un proxy de confianza al frente; expuesto directo a
  // internet permitiría falsificar la IP con la cabecera X-Forwarded-For.
  if (process.env.TRUST_PROXY === 'true') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  /*
   * El origen permitido sale de `APP_URL`, o de `CORS_ORIGINS` cuando hacen falta
   * varios dominios. Solo si no hay ninguna de las dos se abre a `*`, y en
   * producción eso se avisa: una API abierta a cualquier origen deja que cualquier
   * página ejecute peticiones con la sesión del usuario que la visite.
   */
  const origenes = origenesCors();

  if (!origenes && esProduccion()) {
    logger.error(
      'CORS abierto a cualquier origen en producción. Defina APP_URL (o ' +
        'CORS_ORIGINS si son varios dominios).',
    );
  }

  app.enableCors({
    origin: origenes ?? '*',
    // Sin esto el navegador oculta la cabecera y el frontend no puede leer el
    // nombre del archivo al descargar un reporte: se ve un xlsx guardado con un
    // nombre inventado por el cliente en vez del que propuso el servidor.
    exposedHeaders: ['Content-Disposition'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  /*
   * Se imprime la configuración pública al arrancar, y no es decorativo: es lo que
   * permite ver de un vistazo si el despliegue quedó apuntando a donde debe. Un
   * link de pago que vuelve a localhost se cobra igual y el pase no se confirma
   * nunca, así que el momento de notarlo es ahora y no cuando un visitante reclame.
   */
  logger.log(`Escuchando en el puerto ${port}`);
  logger.log(`Frontend: ${urlAplicacion() || '(APP_URL sin definir)'}`);
  logger.log(`CORS: ${origenes ? origenes.join(', ') : 'cualquier origen (*)'}`);
  logger.log(`Retorno de pago: ${urlExito()}`);
  logger.log(`Webhook a registrar en Recurrente: ${urlWebhook()}`);

  const problemas = problemasDeDespliegue();

  if (problemas.length && esProduccion()) {
    logger.error(
      `Revise la configuración antes de operar (${problemas.length}):`,
    );
    problemas.forEach((p) => logger.error(`  - ${p}`));
  } else if (problemas.length) {
    logger.warn(
      `Configuración incompleta para producción (${problemas.length}), ` +
        'aceptable en desarrollo:',
    );
    problemas.forEach((p) => logger.warn(`  - ${p}`));
  }
}
bootstrap();
