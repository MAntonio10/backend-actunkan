/**
 * Registra el módulo 'Sincronizacion' como sub-módulo de 'EmisionTickets'.
 *
 * Separa del permiso de emitir dos capacidades que hoy van juntas:
 *  - 'Ver'    entrar a la pantalla de sincronización y ver la cola pendiente.
 *  - 'Anular' descartar una venta cobrada sin conexión ANTES de subirla.
 *
 * 'Anular' es el que importa: esa venta ya cobró dinero y todavía no existe en el
 * servidor, así que descartarla no deja rastro en ninguna parte salvo que se exija
 * un permiso propio. Con 'EmisionTickets.Anular' bastaba, y ese lo tiene cualquier
 * taquillero para corregir un ticket mal emitido.
 *
 * ADITIVO y idempotente: no borra ni reasigna nada. Además CONCEDE los permisos
 * nuevos a quien ya tiene 'EmisionTickets.Crear', para que nadie pierda de golpe
 * el acceso a una pantalla que hoy usa. Quitárselo después es decisión del
 * administrador, no efecto colateral de un despliegue.
 *
 * Uso: npx ts-node prisma/seed-sincronizacion.ts
 */
import { PrismaClient } from '@prisma/client';

const MODULO = 'Sincronizacion';
const MODULO_PADRE = 'EmisionTickets';
const ACCIONES = ['Ver', 'Anular'];

async function main() {
  const prisma = new PrismaClient();

  const padre = await prisma.modulo.findUnique({ where: { nombre: MODULO_PADRE } });
  if (!padre) {
    throw new Error(
      `No existe el módulo '${MODULO_PADRE}'. Corra antes 'npx ts-node prisma/seed-tickets.ts'.`,
    );
  }

  const acciones: Record<string, number> = {};
  for (const nombre of ACCIONES) {
    const existente = await prisma.accion.findUnique({ where: { nombre } });
    const accion = existente ?? (await prisma.accion.create({ data: { nombre } }));
    acciones[nombre] = accion.id;
    console.log(`Accion '${nombre}' -> id ${accion.id}${existente ? ' (ya existía)' : ' (creada)'}`);
  }

  const existente = await prisma.modulo.findUnique({ where: { nombre: MODULO } });
  const modulo =
    existente ??
    (await prisma.modulo.create({
      data: { nombre: MODULO, idModuloPadre: padre.id, esAsignable: true },
    }));
  console.log(
    `Modulo '${MODULO}' -> id ${modulo.id}${existente ? ' (ya existía)' : ` (creado, hijo de ${MODULO_PADRE})`}`,
  );

  const vinculos: number[] = [];
  for (const nombre of ACCIONES) {
    const idAccion = acciones[nombre];
    const vinculo =
      (await prisma.moduloAccion.findUnique({
        where: { idModulo_idAccion: { idModulo: modulo.id, idAccion } },
      })) ??
      (await prisma.moduloAccion.create({ data: { idModulo: modulo.id, idAccion } }));
    vinculos.push(vinculo.id);
    console.log(`  ${MODULO}.${nombre} -> moduloAccion ${vinculo.id}`);
  }

  // Quien ya emite tickets ya venía usando la pantalla de sincronización: se le
  // conserva el acceso. Sin esto, el despliegue dejaría las taquillas sin poder
  // subir su cola hasta que alguien repartiera permisos a mano.
  const emisionCrear = await prisma.moduloAccion.findFirst({
    where: { modulo: { nombre: MODULO_PADRE }, accion: { nombre: 'Crear' } },
  });

  let concedidos = 0;
  if (emisionCrear) {
    const quienesEmiten = await prisma.permisos.findMany({
      where: { idModuloAccion: emisionCrear.id },
      select: { idUsuario: true },
    });

    for (const { idUsuario } of quienesEmiten) {
      for (const idModuloAccion of vinculos) {
        const ya = await prisma.permisos.findUnique({
          where: { idUsuario_idModuloAccion: { idUsuario, idModuloAccion } },
        });
        if (!ya) {
          await prisma.permisos.create({ data: { idUsuario, idModuloAccion } });
          concedidos += 1;
        }
      }
    }
    console.log(
      `\nUsuarios con '${MODULO_PADRE}.Crear': ${quienesEmiten.length}. Permisos concedidos: ${concedidos}.`,
    );
  }

  console.log('\nListo.');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
