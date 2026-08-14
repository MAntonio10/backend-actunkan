/**
 * Reorganiza la tabla `Modulo` según la arquitectura real del sistema:
 * módulos GENERALES que pueden agrupar SUB-MÓDULOS.
 *
 *   Emision de Tickets -> un único módulo 'EmisionTickets'. Atracciones, guías,
 *   tarifas, países, tipos y opciones de pago NO son módulos aparte: son parte de él.
 *
 *   Cajas -> módulo general, con 'Gastos' como sub-módulo (permisos propios:
 *   Ver/Crear/Editar/Anular gastos, siempre sobre una caja abierta y no anulada).
 *
 * Nunca borra filas: los módulos que dejan de usarse se marcan `anulado = true`,
 * conservando su historial y sus vínculos módulo-acción.
 *
 * Idempotente. Uso: npx ts-node prisma/reorganizar-modulos.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Módulos que se absorbieron dentro de 'EmisionTickets'. */
const ABSORBIDOS_POR_EMISION = [
  'Paises',
  'Atracciones',
  'OrigenesVisitante',
  'TiposVisitante',
  'TiposRecorrido',
  'OpcionesPago',
  'Guias',
  'Tarifas',
];

/** Módulos que se absorbieron dentro del sub-módulo 'Gastos'. */
const ABSORBIDOS_POR_GASTOS = ['TiposGasto'];

const ACCIONES = ['Ver', 'Crear', 'Editar', 'Anular'];

async function asegurarModulo(nombre: string, idModuloPadre: number | null = null) {
  const existente = await prisma.modulo.findUnique({ where: { nombre } });

  const modulo =
    existente ?? (await prisma.modulo.create({ data: { nombre, idModuloPadre } }));

  // Reactiva y corrige la jerarquía si hiciera falta.
  if (existente && (existente.anulado || existente.idModuloPadre !== idModuloPadre)) {
    return prisma.modulo.update({
      where: { id: existente.id },
      data: { anulado: false, idModuloPadre },
    });
  }

  return modulo;
}

async function vincularAcciones(idModulo: number, nombreModulo: string) {
  let creados = 0;

  for (const nombreAccion of ACCIONES) {
    const existenteAccion = await prisma.accion.findUnique({ where: { nombre: nombreAccion } });
    const accion =
      existenteAccion ?? (await prisma.accion.create({ data: { nombre: nombreAccion } }));

    const vinculo = await prisma.moduloAccion.findUnique({
      where: { idModulo_idAccion: { idModulo, idAccion: accion.id } },
    });

    if (!vinculo) {
      await prisma.moduloAccion.create({ data: { idModulo, idAccion: accion.id } });
      creados++;
    }
  }

  if (creados) console.log(`  ${nombreModulo}: ${creados} vínculo(s) módulo-acción creados.`);
}

async function anularAbsorbido(nombre: string, absorbidoPor: string) {
  const modulo = await prisma.modulo.findUnique({ where: { nombre } });
  if (!modulo) return;

  const permisos = await prisma.permisos.count({
    where: { moduloAccion: { idModulo: modulo.id } },
  });

  if (permisos > 0) {
    // No se desactiva a ciegas un módulo que alguien está usando.
    console.log(
      `  AVISO: '${nombre}' tiene ${permisos} permiso(s) asignados. Se deja activo; ` +
        `reasigne esos permisos a '${absorbidoPor}' antes de anularlo.`,
    );
    return;
  }

  if (!modulo.anulado) {
    await prisma.modulo.update({ where: { id: modulo.id }, data: { anulado: true } });
    console.log(`  '${nombre}' anulado (absorbido por '${absorbidoPor}').`);
  }
}

/**
 * Renombra un módulo conservando su id: los `Permisos` ya asignados apuntan a
 * `ModuloAccion.idModulo`, no al nombre, así que nadie pierde acceso.
 */
async function renombrarModulo(nombreViejo: string, nombreNuevo: string) {
  const viejo = await prisma.modulo.findUnique({ where: { nombre: nombreViejo } });
  const nuevo = await prisma.modulo.findUnique({ where: { nombre: nombreNuevo } });

  if (!viejo || nuevo) return;

  const permisos = await prisma.permisos.count({
    where: { moduloAccion: { idModulo: viejo.id } },
  });

  await prisma.modulo.update({
    where: { id: viejo.id },
    data: { nombre: nombreNuevo },
  });

  console.log(
    `Módulo '${nombreViejo}' renombrado a '${nombreNuevo}' (id ${viejo.id}). ` +
      `${permisos} permiso(s) asignados se conservan.`,
  );
}

/**
 * Módulos internos que existen para el sistema pero no se conceden a ningún usuario.
 *
 * 'Modulos' y 'Acciones' estuvieron aquí y se eliminaron de la tabla: se protegían a
 * sí mismos y confundían la asignación de permisos. Sus rutas ahora dependen de
 * 'Usuarios'. La lista queda para cualquier módulo interno que se agregue después.
 */
const NO_ASIGNABLES: string[] = [];

async function marcarNoAsignables() {
  for (const nombre of NO_ASIGNABLES) {
    const modulo = await prisma.modulo.findUnique({ where: { nombre } });
    if (!modulo || !modulo.esAsignable) continue;

    await prisma.modulo.update({ where: { id: modulo.id }, data: { esAsignable: false } });

    const permisos = await prisma.permisos.count({
      where: { moduloAccion: { idModulo: modulo.id } },
    });

    console.log(
      `Módulo '${nombre}' marcado como NO asignable.` +
        (permisos
          ? ` Conserva ${permisos} permiso(s) ya asignados; no se borran, pero la API ya no acepta asignarlo de nuevo.`
          : ''),
    );
  }
}

async function main() {
  // --- 0. Bitácora: el módulo se llamaba 'Auditoria' ---
  await renombrarModulo('Auditoria', 'Bitacora');
  await marcarNoAsignables();

  // --- 1. Emisión de Tickets: renombrar 'Tickets' y absorber sus catálogos ---
  const tickets = await prisma.modulo.findUnique({ where: { nombre: 'Tickets' } });
  const emision = await prisma.modulo.findUnique({ where: { nombre: 'EmisionTickets' } });

  if (tickets && !emision) {
    await prisma.modulo.update({
      where: { id: tickets.id },
      data: { nombre: 'EmisionTickets', anulado: false, idModuloPadre: null },
    });
    console.log(`Módulo 'Tickets' renombrado a 'EmisionTickets' (id ${tickets.id}).`);
  }

  const moduloEmision = await asegurarModulo('EmisionTickets');
  console.log(`Módulo general 'EmisionTickets' -> id ${moduloEmision.id}`);
  await vincularAcciones(moduloEmision.id, 'EmisionTickets');

  for (const nombre of ABSORBIDOS_POR_EMISION) {
    await anularAbsorbido(nombre, 'EmisionTickets');
  }

  // --- 2. Cajas (general) con 'Gastos' como sub-módulo ---
  const moduloCajas = await asegurarModulo('Cajas');
  console.log(`Módulo general 'Cajas' -> id ${moduloCajas.id}`);
  await vincularAcciones(moduloCajas.id, 'Cajas');

  const moduloGastos = await asegurarModulo('Gastos', moduloCajas.id);
  console.log(`Sub-módulo 'Gastos' -> id ${moduloGastos.id} (padre: Cajas)`);
  await vincularAcciones(moduloGastos.id, 'Gastos');

  for (const nombre of ABSORBIDOS_POR_GASTOS) {
    await anularAbsorbido(nombre, 'Gastos');
  }

  // --- Resumen ---
  const modulos = await prisma.modulo.findMany({
    where: { anulado: false },
    include: { moduloPadre: { select: { nombre: true } } },
    orderBy: { id: 'asc' },
  });

  console.log('\nMódulos activos:');
  for (const m of modulos) {
    const padre = m.moduloPadre ? `  (sub-módulo de ${m.moduloPadre.nombre})` : '';
    console.log(`  ${String(m.id).padStart(2)} ${m.nombre}${padre}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
