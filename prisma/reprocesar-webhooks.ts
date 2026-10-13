/**
 * Vuelve a procesar avisos de pago ya archivados en `EventoPagoPasarela`.
 *
 * Existe porque los primeros avisos reales de Recurrente llegaron como
 * `payment_intent.succeeded` y el webhook solo reconocía `intent.succeeded`: se
 * archivaron como TIPO_NO_SOPORTADO y sus pagos quedaron PENDIENTE. Pedirle a la
 * pasarela que los reenvíe no sirve, porque llegan con el mismo `svix-id` y el
 * webhook los descarta como duplicados.
 *
 * Usa el cuerpo guardado, cuya firma ya se verificó al recibirlo, y la misma lógica
 * del webhook (montos, orden de estados, bitácora). Por cada evento, borrar la fila
 * vieja y procesarlo de nuevo van en una sola transacción: si algo falla, el evento
 * queda como estaba y no se pierde la evidencia.
 *
 * Solo toca eventos TIPO_NO_SOPORTADO o IGNORADO_INCONSISTENTE. Repetirlo es
 * inofensivo: lo ya aplicado queda con otro resultado y no se vuelve a tomar.
 *
 * Uso: npx ts-node prisma/reprocesar-webhooks.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { WebhookRecurrenteService } from '../src/pagos/webhook-recurrente.service';

const prisma = new PrismaClient();

const REPROCESABLES = ['TIPO_NO_SOPORTADO', 'IGNORADO_INCONSISTENTE'];

async function main() {
  const servicio: any = new WebhookRecurrenteService(prisma as any);

  const eventos = await prisma.eventoPagoPasarela.findMany({
    where: { resultado: { in: REPROCESABLES } },
    orderBy: { id: 'asc' },
  });

  console.log(`Eventos a reprocesar: ${eventos.length}.`);

  for (const fila of eventos) {
    const evento = JSON.parse(fila.cargaUtil);

    const { resultado } = await prisma.$transaction(async (tx) => {
      await tx.eventoPagoPasarela.delete({ where: { id: fila.id } });

      return servicio.procesarEnTransaccion(tx, {
        idEvento: fila.idEvento,
        tipoEvento: String(evento?.event_type ?? 'desconocido'),
        idCheckout: servicio.extraerIdCheckout(evento),
        evento,
        cuerpoCrudo: fila.cargaUtil,
      });
    });

    console.log(`  ${fila.tipoEvento} ${fila.idCheckout ?? '(sin checkout)'}: ${fila.resultado} -> ${resultado}`);
  }

  console.log('\nListo.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
