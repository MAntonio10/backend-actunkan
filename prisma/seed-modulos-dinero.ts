/**
 * Registra el módulo general 'Cajas' y su sub-módulo 'Gastos', y los vincula con
 * las acciones del catálogo. Sin esto, PermissionsGuard responde 403 a todos.
 *
 * 'TiposGasto' ya no es un módulo de permiso propio: el catálogo de tipos de gasto
 * queda dentro del sub-módulo 'Gastos' (ver prisma/reorganizar-modulos.ts, que
 * además enlaza 'Gastos' como hijo de 'Cajas').
 *
 * Idempotente y estrictamente aditivo: no borra ni reasigna permisos de usuarios.
 * Uso: npx ts-node prisma/seed-modulos-dinero.ts
 */
import { PrismaClient } from '@prisma/client';

const ACCIONES = ['Ver', 'Crear', 'Editar', 'Anular'];
const MODULOS = ['Cajas', 'Gastos'];

async function main() {
  const prisma = new PrismaClient();

  // 1. Acciones del catálogo (reutiliza las existentes)
  const acciones: Record<string, number> = {};
  for (const nombre of ACCIONES) {
    const existente = await prisma.accion.findUnique({ where: { nombre } });
    const accion = existente ?? (await prisma.accion.create({ data: { nombre } }));
    acciones[nombre] = accion.id;
    console.log(`Accion '${nombre}' -> id ${accion.id}${existente ? ' (ya existía)' : ' (creada)'}`);
  }

  // 2. Módulos + vinculación módulo-acción
  for (const nombre of MODULOS) {
    const existente = await prisma.modulo.findUnique({ where: { nombre } });
    const modulo = existente ?? (await prisma.modulo.create({ data: { nombre } }));
    console.log(`Modulo '${nombre}' -> id ${modulo.id}${existente ? ' (ya existía)' : ' (creado)'}`);

    if (modulo.anulado) {
      console.log(`  AVISO: el módulo '${nombre}' está anulado; reactívelo para poder usarlo.`);
    }

    for (const accionNombre of ACCIONES) {
      const idAccion = acciones[accionNombre];
      const vinculo = await prisma.moduloAccion.findUnique({
        where: { idModulo_idAccion: { idModulo: modulo.id, idAccion } },
      });

      if (vinculo) {
        console.log(`  ${nombre}.${accionNombre} -> moduloAccion ${vinculo.id} (ya existía)`);
      } else {
        const creado = await prisma.moduloAccion.create({
          data: { idModulo: modulo.id, idAccion },
        });
        console.log(`  ${nombre}.${accionNombre} -> moduloAccion ${creado.id} (creado)`);
      }
    }
  }

  console.log(
    '\nListo. Falta asignar los permisos a cada usuario (POST /usuarios/:id/permisos).',
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
