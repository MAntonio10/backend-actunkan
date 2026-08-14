/**
 * Siembra los catálogos, tarifas iniciales y módulos de permisos del módulo de Tickets.
 *
 * Estrictamente aditivo e idempotente: solo inserta lo que falta, nunca borra ni
 * sobrescribe precios ya vigentes.
 *
 * Uso: npx ts-node prisma/seed-tickets.ts
 */
import { PrismaClient } from '@prisma/client';
import { PAISES } from './data/paises';

const prisma = new PrismaClient();

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
 * Tarifas por origen y categoría (iguales para ambas atracciones al arrancar).
 * `centro_educativo` no aparece en extranjero a propósito: la ausencia de tarifa
 * vigente es la forma de representar "no aplica".
 */
const TARIFAS: Record<string, Record<string, number>> = {
  nacional: { adulto: 20, nino: 10, nino_menor: 0, centro_educativo: 5 },
  extranjero: { adulto: 25, nino: 25, nino_menor: 0 },
};

const PRECIO_TICKET_GUIA = 15;

/**
 * Emisión de Tickets es un módulo GENERAL: atracciones, guías, tarifas, países,
 * tipos y opciones de pago viven dentro de él, no como módulos de permiso aparte.
 * Quien tiene el permiso lo tiene sobre todo el módulo, con la granularidad de
 * las 4 acciones (Ver / Crear / Editar / Anular).
 */
const MODULOS_TICKETS = ['EmisionTickets'];
const ACCIONES = ['Ver', 'Crear', 'Editar', 'Anular'];

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
      (await modelo.create({
        data: { ...fila, fechaCreacion: ahora, fechaActualizacion: ahora },
      }));

    mapa[fila.codigo] = registro.id;
    if (!existente) creados++;
  }

  console.log(`${etiqueta}: ${filas.length} revisados, ${creados} creados.`);
  return mapa;
}

async function main() {
  const ahora = new Date();

  // --- Países ---
  let paisesCreados = 0;
  for (const pais of PAISES) {
    const existente = await prisma.pais.findUnique({ where: { nombre: pais.nombre } });
    if (!existente) {
      await prisma.pais.create({
        data: { ...pais, fechaCreacion: ahora, fechaActualizacion: ahora },
      });
      paisesCreados++;
    }
  }
  console.log(`Países: ${PAISES.length} revisados, ${paisesCreados} creados.`);

  // --- Catálogos con código ---
  const atracciones = await sembrarCatalogoPorCodigo(
    prisma.atraccion,
    'Atracciones',
    ATRACCIONES,
    ahora,
  );
  const origenes = await sembrarCatalogoPorCodigo(
    prisma.origenVisitante,
    'Orígenes de visitante',
    ORIGENES,
    ahora,
  );
  const tiposVisitante = await sembrarCatalogoPorCodigo(
    prisma.tipoVisitante,
    'Tipos de visitante',
    TIPOS_VISITANTE,
    ahora,
  );
  await sembrarCatalogoPorCodigo(
    prisma.tipoRecorrido,
    'Tipos de recorrido',
    TIPOS_RECORRIDO,
    ahora,
  );

  // --- Opciones de pago (esEfectivo alimenta el arqueo de caja) ---
  let opcionesCreadas = 0;
  for (const opcion of OPCIONES_PAGO) {
    const existente = await prisma.opcionPago.findFirst({ where: { nombre: opcion.nombre } });
    if (!existente) {
      await prisma.opcionPago.create({
        data: { ...opcion, fechaCreacion: ahora, fechaActualizacion: ahora },
      });
      opcionesCreadas++;
    }
  }
  console.log(`Opciones de pago: ${OPCIONES_PAGO.length} revisadas, ${opcionesCreadas} creadas.`);

  // --- Tarifas iniciales (no toca las que ya estén vigentes) ---
  let tarifasCreadas = 0;
  for (const [codigoAtraccion, idAtraccion] of Object.entries(atracciones)) {
    for (const [codigoOrigen, precios] of Object.entries(TARIFAS)) {
      const idOrigen = origenes[codigoOrigen];

      for (const [codigoTipo, precio] of Object.entries(precios)) {
        const idTipoVisitante = tiposVisitante[codigoTipo];
        if (!idTipoVisitante) continue;

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
          console.log(`  Tarifa ${codigoAtraccion}/${codigoOrigen}/${codigoTipo} = Q${precio}`);
        }
      }
    }
  }
  console.log(`Tarifas: ${tarifasCreadas} creadas.`);

  const tarifaGuiaVigente = await prisma.tarifaGuia.findFirst({ where: { vigenteHasta: null } });
  if (!tarifaGuiaVigente) {
    await prisma.tarifaGuia.create({
      data: {
        precio: PRECIO_TICKET_GUIA,
        vigenteDesde: ahora,
        fechaCreacion: ahora,
        fechaActualizacion: ahora,
      },
    });
    console.log(`Tarifa de guía sin carnet: Q${PRECIO_TICKET_GUIA} creada.`);
  } else {
    console.log('Tarifa de guía sin carnet: ya existía.');
  }

  // --- Módulos y acciones de permisos ---
  const acciones: Record<string, number> = {};
  for (const nombre of ACCIONES) {
    const existente = await prisma.accion.findUnique({ where: { nombre } });
    const accion = existente ?? (await prisma.accion.create({ data: { nombre } }));
    acciones[nombre] = accion.id;
  }

  let vinculos = 0;
  for (const nombre of MODULOS_TICKETS) {
    const existente = await prisma.modulo.findUnique({ where: { nombre } });
    const modulo = existente ?? (await prisma.modulo.create({ data: { nombre } }));
    console.log(`Módulo '${nombre}' -> id ${modulo.id}${existente ? ' (ya existía)' : ' (creado)'}`);

    for (const accionNombre of ACCIONES) {
      const idAccion = acciones[accionNombre];
      const vinculo = await prisma.moduloAccion.findUnique({
        where: { idModulo_idAccion: { idModulo: modulo.id, idAccion } },
      });

      if (!vinculo) {
        await prisma.moduloAccion.create({ data: { idModulo: modulo.id, idAccion } });
        vinculos++;
      }
    }
  }
  console.log(`Vínculos módulo-acción creados: ${vinculos}.`);

  console.log('\nListo. Falta asignar los permisos a cada usuario (POST /usuarios/:id/permisos).');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
