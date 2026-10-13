/**
 * Siembra todo lo que una base NUEVA necesita para que el sistema funcione:
 *
 *   1. Catálogos sobre los que se apoyan las reglas de negocio (estados de caja,
 *      orígenes, tipos de visitante, atracciones, recorridos, opciones de pago, países).
 *   2. Tarifas iniciales y la tarifa del guía sin carnet.
 *   3. El catálogo completo de módulos y acciones de permisos.
 *   4. Un puesto 'Administrador' y el usuario administrador con todos los permisos.
 *
 * El paso 4 resuelve el arranque: `POST /usuarios` exige 'Usuarios.Crear', así que
 * sin un primer usuario sembrado nadie podría crear al resto.
 *
 * Las credenciales del administrador salen del `.env` (ADMIN_CORREO, ADMIN_CONTRASENA
 * y, opcional, ADMIN_NOMBRE), nunca del código: este archivo se versiona.
 *
 * Idempotente y aditivo: solo inserta lo que falta. Si el administrador ya existe NO
 * se le cambia la contraseña; solo se le completan los permisos que le falten.
 *
 * Orden en una base limpia:
 *   npx prisma db push
 *   npx ts-node prisma/aplicar-indices-offline.ts
 *   npx ts-node prisma/aplicar-indices-reportes.ts
 *   npx ts-node prisma/seed-base.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PAISES } from './data/paises';
import { getFechaUTC6 } from '../src/common/utils/date.util';

const prisma = new PrismaClient();

/** Los busca `cajas.service.ts` por nombre exacto. */
const ESTADOS_CAJA = ['Abierta', 'Cerrada'];

const ATRACCIONES = [
  { codigo: 'cuevas', nombre: 'Cuevas Actun Kan' },
  { codigo: 'mariposario', nombre: 'Mariposario' },
];

const ORIGENES = [
  { codigo: 'nacional', nombre: 'Nacional' },
  { codigo: 'extranjero', nombre: 'Extranjero' },
];

const TIPOS_VISITANTE = [
  { codigo: 'adulto', nombre: 'Adulto' },
  { codigo: 'nino', nombre: 'Niño (7 años o más)' },
  { codigo: 'nino_menor', nombre: 'Niño menor de 7 años' },
  { codigo: 'centro_educativo', nombre: 'Centro educativo (nivel primario)' },
  { codigo: 'visitante_especial', nombre: 'Visitante especial' },
];

const TIPOS_RECORRIDO = [
  { codigo: 'corto', nombre: 'Recorrido corto (~45 minutos)' },
  { codigo: 'largo', nombre: 'Recorrido largo (~2 horas)' },
];

const OPCIONES_PAGO = [
  { nombre: 'Efectivo', esEfectivo: true },
  { nombre: 'Tarjeta', esEfectivo: false },
];

/**
 * Iguales para ambas atracciones al arrancar. `centro_educativo` no aparece en
 * extranjero a propósito: la ausencia de tarifa vigente representa "no aplica".
 */
const TARIFAS: Record<string, Record<string, number>> = {
  nacional: { adulto: 20, nino: 10, nino_menor: 0, centro_educativo: 5, visitante_especial: 0 },
  extranjero: { adulto: 25, nino: 25, nino_menor: 0, visitante_especial: 0 },
};

const PRECIO_TICKET_GUIA = 15;

/**
 * Cada par módulo-acción que el código exige con `@RequirePermission`. Los módulos
 * con padre son sub-módulos; el padre debe ir antes en la lista.
 */
const MODULOS: Array<{ nombre: string; acciones: string[]; padre?: string }> = [
  { nombre: 'EmisionTickets', acciones: ['Ver', 'Crear', 'Editar', 'Anular'] },
  { nombre: 'Sincronizacion', acciones: ['Ver', 'Anular'], padre: 'EmisionTickets' },
  { nombre: 'Cajas', acciones: ['Ver', 'Crear', 'Editar', 'Anular'] },
  { nombre: 'Donaciones', acciones: ['Ver', 'Crear', 'Anular'] },
  { nombre: 'ActividadesParque', acciones: ['Ver', 'Crear', 'Editar', 'Anular'] },
  { nombre: 'Reportes', acciones: ['Ver', 'Exportar'] },
  { nombre: 'Usuarios', acciones: ['Ver', 'Crear', 'Editar', 'Anular'] },
  { nombre: 'Puestos', acciones: ['Ver', 'Crear', 'Editar', 'Anular'] },
  { nombre: 'Bitacora', acciones: ['Ver'] },
];

const PUESTO_ADMIN = 'Administrador';

async function sembrarCatalogoPorCodigo(
  modelo: any,
  etiqueta: string,
  filas: Array<{ codigo: string; nombre: string }>,
  ahora: Date,
) {
  const mapa: Record<string, number> = {};
  let creados = 0;

  for (const fila of filas) {
    const existente = await modelo.findUnique({ where: { codigo: fila.codigo } });
    const registro =
      existente ??
      (await modelo.create({ data: { ...fila, fechaCreacion: ahora, fechaActualizacion: ahora } }));

    mapa[fila.codigo] = registro.id;
    if (!existente) creados++;
  }

  console.log(`${etiqueta}: ${filas.length} revisados, ${creados} creados.`);
  return mapa;
}

async function sembrarCatalogos(ahora: Date) {
  let estadosCreados = 0;
  for (const nombre of ESTADOS_CAJA) {
    if (!(await prisma.estadoCaja.findFirst({ where: { nombre } }))) {
      await prisma.estadoCaja.create({ data: { nombre } });
      estadosCreados++;
    }
  }
  console.log(`Estados de caja: ${ESTADOS_CAJA.length} revisados, ${estadosCreados} creados.`);

  let paisesCreados = 0;
  for (const pais of PAISES) {
    if (!(await prisma.pais.findUnique({ where: { nombre: pais.nombre } }))) {
      await prisma.pais.create({ data: { ...pais, fechaCreacion: ahora, fechaActualizacion: ahora } });
      paisesCreados++;
    }
  }
  console.log(`Países: ${PAISES.length} revisados, ${paisesCreados} creados.`);

  const atracciones = await sembrarCatalogoPorCodigo(prisma.atraccion, 'Atracciones', ATRACCIONES, ahora);
  const origenes = await sembrarCatalogoPorCodigo(prisma.origenVisitante, 'Orígenes de visitante', ORIGENES, ahora);
  const tiposVisitante = await sembrarCatalogoPorCodigo(
    prisma.tipoVisitante,
    'Tipos de visitante',
    TIPOS_VISITANTE,
    ahora,
  );
  await sembrarCatalogoPorCodigo(prisma.tipoRecorrido, 'Tipos de recorrido', TIPOS_RECORRIDO, ahora);

  let opcionesCreadas = 0;
  for (const opcion of OPCIONES_PAGO) {
    if (!(await prisma.opcionPago.findFirst({ where: { nombre: opcion.nombre } }))) {
      await prisma.opcionPago.create({ data: { ...opcion, fechaCreacion: ahora, fechaActualizacion: ahora } });
      opcionesCreadas++;
    }
  }
  console.log(`Opciones de pago: ${OPCIONES_PAGO.length} revisadas, ${opcionesCreadas} creadas.`);

  // Tarifas: no toca las que ya estén vigentes.
  let tarifasCreadas = 0;
  for (const idAtraccion of Object.values(atracciones)) {
    for (const [codigoOrigen, precios] of Object.entries(TARIFAS)) {
      const idOrigen = origenes[codigoOrigen];

      for (const [codigoTipo, precio] of Object.entries(precios)) {
        const idTipoVisitante = tiposVisitante[codigoTipo];
        const vigente = await prisma.tarifa.findFirst({
          where: { idAtraccion, idOrigen, idTipoVisitante, vigenteHasta: null },
        });

        if (!vigente) {
          await prisma.tarifa.create({
            data: {
              idAtraccion,
              idOrigen,
              idTipoVisitante,
              precio,
              vigenteDesde: ahora,
              fechaCreacion: ahora,
              fechaActualizacion: ahora,
            },
          });
          tarifasCreadas++;
        }
      }
    }
  }
  console.log(`Tarifas: ${tarifasCreadas} creadas.`);

  if (!(await prisma.tarifaGuia.findFirst({ where: { vigenteHasta: null } }))) {
    await prisma.tarifaGuia.create({
      data: { precio: PRECIO_TICKET_GUIA, vigenteDesde: ahora, fechaCreacion: ahora, fechaActualizacion: ahora },
    });
    console.log(`Tarifa de guía sin carnet: Q${PRECIO_TICKET_GUIA} creada.`);
  }
}

async function sembrarPermisos() {
  const idsPorModulo: Record<string, number> = {};
  let vinculos = 0;

  for (const def of MODULOS) {
    const idModuloPadre = def.padre ? idsPorModulo[def.padre] : null;
    const existente = await prisma.modulo.findUnique({ where: { nombre: def.nombre } });
    const modulo =
      existente ?? (await prisma.modulo.create({ data: { nombre: def.nombre, idModuloPadre } }));

    if (existente?.anulado) {
      console.log(`  AVISO: el módulo '${def.nombre}' está anulado; no se reactiva automáticamente.`);
    }
    idsPorModulo[def.nombre] = modulo.id;

    for (const nombreAccion of def.acciones) {
      const accion =
        (await prisma.accion.findUnique({ where: { nombre: nombreAccion } })) ??
        (await prisma.accion.create({ data: { nombre: nombreAccion } }));

      const vinculo = await prisma.moduloAccion.findUnique({
        where: { idModulo_idAccion: { idModulo: modulo.id, idAccion: accion.id } },
      });
      if (!vinculo) {
        await prisma.moduloAccion.create({ data: { idModulo: modulo.id, idAccion: accion.id } });
        vinculos++;
      }
    }
  }

  console.log(`Módulos: ${MODULOS.length} revisados. Vínculos módulo-acción creados: ${vinculos}.`);
}

async function sembrarAdministrador(ahora: Date) {
  const correo = process.env.ADMIN_CORREO?.trim().toLowerCase();
  const contrasena = process.env.ADMIN_CONTRASENA;
  const nombre = process.env.ADMIN_NOMBRE?.trim() || 'Administrador';

  if (!correo || !contrasena) {
    throw new Error('Defina ADMIN_CORREO y ADMIN_CONTRASENA en el .env para crear el administrador.');
  }

  const puesto =
    (await prisma.puestos.findUnique({ where: { nombre: PUESTO_ADMIN } })) ??
    (await prisma.puestos.create({
      data: {
        nombre: PUESTO_ADMIN,
        descripcion: 'Acceso completo al sistema.',
        fechaCreacion: ahora,
        fechaActualizacion: ahora,
      },
    }));

  let usuario = await prisma.usuario.findUnique({ where: { correo } });
  if (usuario) {
    console.log(`Administrador '${correo}' ya existía (id ${usuario.id}); su contraseña no se modifica.`);
  } else {
    const salt = await bcrypt.genSalt(10);
    usuario = await prisma.usuario.create({
      data: {
        idPuesto: puesto.id,
        nombre,
        correo,
        contrasena: await bcrypt.hash(contrasena, salt),
        fechaCreacion: ahora,
        fechaActualizacion: ahora,
      },
    });
    console.log(`Administrador '${correo}' creado (id ${usuario.id}).`);
  }

  // Todos los permisos de los módulos activos y asignables.
  const moduloAcciones = await prisma.moduloAccion.findMany({
    where: { modulo: { anulado: false, esAsignable: true } },
    select: { id: true },
  });

  let concedidos = 0;
  for (const { id: idModuloAccion } of moduloAcciones) {
    const ya = await prisma.permisos.findUnique({
      where: { idUsuario_idModuloAccion: { idUsuario: usuario.id, idModuloAccion } },
    });
    if (!ya) {
      await prisma.permisos.create({ data: { idUsuario: usuario.id, idModuloAccion } });
      concedidos++;
    }
  }
  console.log(`Permisos del administrador: ${moduloAcciones.length} en total, ${concedidos} concedidos ahora.`);
}

async function main() {
  // Reloj de pared de Guatemala, la convención de toda la base. Con `new Date()`
  // las tarifas quedaban vigentes 6 horas en el futuro y no se podía vender.
  const ahora = getFechaUTC6();

  await sembrarCatalogos(ahora);
  await sembrarPermisos();
  await sembrarAdministrador(ahora);

  console.log('\nBase lista.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
