/**
 * Registra el módulo 'Reportes' y lo vincula con las acciones que usa.
 * Sin esto, PermissionsGuard responde 403 a todas las rutas de /reportes.
 *
 * Solo dos acciones, y a propósito:
 *   * 'Ver'      -> consultar el catálogo, ejecutar un reporte en JSON y pedir una
 *                   interpretación en lenguaje natural.
 *   * 'Exportar' -> descargar el PDF o el Excel.
 *
 * 'Crear', 'Editar' y 'Anular' no tienen sentido aquí: un reporte no se guarda, se
 * genera. Y la supervisión tampoco es una acción propia de este módulo: quién puede ver
 * el monto esperado de un arqueo lo sigue decidiendo 'Cajas' + 'Editar', igual que en
 * /cajas. Inventar un 'Reportes.Editar' equivalente crearía una segunda definición de
 * supervisor que podría desincronizarse de la primera, y con ella el control que impide
 * que el cajero conozca la cifra que debe cuadrar.
 *
 * Idempotente y estrictamente aditivo: no borra ni reasigna permisos de usuarios.
 * Uso: npx ts-node prisma/seed-reportes.ts
 */
import { PrismaClient } from '@prisma/client';

const ACCIONES = ['Ver', 'Exportar'];
const MODULO = 'Reportes';

async function main() {
  const prisma = new PrismaClient();

  // 1. Acciones del catálogo. 'Exportar' ya existe desde el inicio del proyecto pero
  //    ningún módulo la usaba todavía; este es el primero.
  const acciones: Record<string, number> = {};
  for (const nombre of ACCIONES) {
    const existente = await prisma.accion.findUnique({ where: { nombre } });
    const accion = existente ?? (await prisma.accion.create({ data: { nombre } }));
    acciones[nombre] = accion.id;
    console.log(`Accion '${nombre}' -> id ${accion.id}${existente ? ' (ya existía)' : ' (creada)'}`);
  }

  // 2. Módulo + vinculación módulo-acción
  const existente = await prisma.modulo.findUnique({ where: { nombre: MODULO } });
  const modulo = existente ?? (await prisma.modulo.create({ data: { nombre: MODULO } }));
  console.log(`Modulo '${MODULO}' -> id ${modulo.id}${existente ? ' (ya existía)' : ' (creado)'}`);

  if (modulo.anulado) {
    console.log(`  AVISO: el módulo '${MODULO}' está anulado; reactívelo para poder usarlo.`);
  }

  for (const accionNombre of ACCIONES) {
    const idAccion = acciones[accionNombre];
    const vinculo = await prisma.moduloAccion.findUnique({
      where: { idModulo_idAccion: { idModulo: modulo.id, idAccion } },
    });

    if (vinculo) {
      console.log(`  ${MODULO}.${accionNombre} -> moduloAccion ${vinculo.id} (ya existía)`);
    } else {
      const creado = await prisma.moduloAccion.create({
        data: { idModulo: modulo.id, idAccion },
      });
      console.log(`  ${MODULO}.${accionNombre} -> moduloAccion ${creado.id} (creado)`);
    }
  }

  console.log('\nListo. Falta asignar los permisos a cada usuario (POST /usuarios/:id/permisos).');
  console.log(
    'Recuerde que además de Reportes.Ver, cada usuario necesita el permiso Ver del módulo\n' +
      'dueño de los datos de cada reporte (EmisionTickets, Cajas, Donaciones, Bitacora,\n' +
      'Usuarios o ActividadesParque). GET /reportes ya filtra el catálogo por eso.',
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
