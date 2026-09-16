import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Detrás de un proxy inverso (nginx, balanceador, Cloudflare) todas las peticiones
  // llegan con la IP del proxy: sin esto el límite por IP sería uno solo compartido
  // por todos los usuarios y bastaría un cliente activo para bloquear al resto.
  // Actívelo SOLO si hay un proxy de confianza al frente; expuesto directo a
  // internet permitiría falsificar la IP con la cabecera X-Forwarded-For.
  if (process.env.TRUST_PROXY === 'true') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  // Durante el desarrollo se acepta cualquier origen. Para cerrarlo en producción
  // basta listar los dominios permitidos en CORS_ORIGINS separados por coma
  // (ej. CORS_ORIGINS=https://app.aktunkan.com,https://admin.aktunkan.com).
  const origenes = process.env.CORS_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origenes?.length ? origenes : '*',
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
  console.log(`Servidor ejecutándose en http://localhost:${port}`);
}
bootstrap();
