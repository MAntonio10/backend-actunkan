/**
 * Registra el módulo de permisos 'ActividadesParque' con sus acciones.
 *
 * El permiso habilita ver y publicar; editar y anular quedan además restringidos
 * al autor de cada publicación, verificado en el servicio.
 *
 * Idempotente y aditivo. Uso: npx ts-node prisma/seed-actividades.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MODULO = 'ActividadesParque';
const ACCIONES = ['Ver', 'Crear', 'Editar', 'Anular'];

async function main() {
  const existente = await prisma.modulo.findUnique({ where: { nombre: MODULO } });
  const modulo = existente ?? (await prisma.modulo.create({ data: { nombre: MODULO } }));

  console.log(`Módulo '${MODULO}' -> id ${modulo.id}${existente ? ' (ya existía)' : ' (creado)'}`);

  if (modulo.anulado) {
    await prisma.modulo.update({ where: { id: modulo.id }, data: { anulado: false } });
    console.log('  Estaba anulado; se reactivó.');
  }

  let creados = 0;
  for (const nombreAccion of ACCIONES) {
    const existenteAccion = await prisma.accion.findUnique({ where: { nombre: nombreAccion } });
    const accion =
      existenteAccion ?? (await prisma.accion.create({ data: { nombre: nombreAccion } }));

    const vinculo = await prisma.moduloAccion.findUnique({
      where: { idModulo_idAccion: { idModulo: modulo.id, idAccion: accion.id } },
    });

    if (!vinculo) {
      await prisma.moduloAccion.create({ data: { idModulo: modulo.id, idAccion: accion.id } });
      creados++;
      console.log(`  ${MODULO}.${nombreAccion}: vinculado.`);
    } else {
      console.log(`  ${MODULO}.${nombreAccion}: ya existía.`);
    }
  }

  console.log(`\nVínculos creados: ${creados}.`);
  console.log('Falta asignar el permiso a los usuarios (POST /usuarios/:id/permisos).');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
