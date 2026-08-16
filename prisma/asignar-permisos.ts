/**
 * Otorga permisos a un usuario de forma ADITIVA.
 *
 * A diferencia de `POST /usuarios/:id/permisos`, que reemplaza la lista completa
 * borrando los permisos previos, este script solo inserta lo que falta. Nada se borra.
 *
 * Uso: npx ts-node prisma/asignar-permisos.ts <idUsuario> <Modulo> [<Modulo> ...]
 * Ej.: npx ts-node prisma/asignar-permisos.ts 3 EmisionTickets Cajas Donaciones
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [idUsuarioArg, ...modulos] = process.argv.slice(2);
  const idUsuario = Number(idUsuarioArg);

  if (!idUsuario || modulos.length === 0) {
    console.error('Uso: npx ts-node prisma/asignar-permisos.ts <idUsuario> <Modulo> [<Modulo> ...]');
    process.exit(1);
  }

  const usuario = await prisma.usuario.findUnique({ where: { id: idUsuario } });
  if (!usuario) {
    console.error(`No existe el usuario con ID ${idUsuario}.`);
    process.exit(1);
  }
  console.log(`Usuario ${usuario.id}: ${usuario.nombre} (${usuario.correo})`);

  for (const nombreModulo of modulos) {
    const modulo = await prisma.modulo.findUnique({ where: { nombre: nombreModulo } });

    if (!modulo) {
      console.log(`  '${nombreModulo}': NO EXISTE, se omite.`);
      continue;
    }
    if (modulo.anulado) {
      console.log(`  '${nombreModulo}': está anulado, se omite.`);
      continue;
    }
    if (!modulo.esAsignable) {
      console.log(`  '${nombreModulo}': no es asignable (módulo de infraestructura), se omite.`);
      continue;
    }

    const moduloAcciones = await prisma.moduloAccion.findMany({
      where: { idModulo: modulo.id },
      include: { accion: true },
    });

    for (const ma of moduloAcciones) {
      const existente = await prisma.permisos.findUnique({
        where: { idUsuario_idModuloAccion: { idUsuario, idModuloAccion: ma.id } },
      });

      if (existente) {
        console.log(`  ${nombreModulo}.${ma.accion.nombre}: ya lo tenía.`);
        continue;
      }

      await prisma.permisos.create({ data: { idUsuario, idModuloAccion: ma.id } });
      console.log(`  ${nombreModulo}.${ma.accion.nombre}: OTORGADO.`);
    }
  }

  const total = await prisma.permisos.count({ where: { idUsuario } });
  console.log(`\nTotal de permisos del usuario ${idUsuario}: ${total}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
