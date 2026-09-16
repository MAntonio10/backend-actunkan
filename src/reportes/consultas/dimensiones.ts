import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Dimensiones por las que se puede desglosar una venta.
 *
 * Es una **lista blanca cerrada**: la clave que llega del cliente (o de la IA) solo se
 * usa para indexar este objeto, nunca se concatena a una consulta. Cualquier valor que
 * no sea una de estas claves no encuentra entrada y se rechaza antes de tocar la base.
 *
 * Todas apuntan a una FK escalar de `Ticket`, que es la condición para que
 * `prisma.ticket.groupBy()` pueda agruparlas: Prisma no agrupa por campos de una
 * relación. Los nombres legibles se resuelven en una segunda consulta al catálogo
 * correspondiente, que tiene decenas de filas.
 */

export type ClaveDimension =
  'vendedor' | 'atraccion' | 'origen' | 'pais' | 'tipoRecorrido' | 'guia';

export interface Dimension {
  /** Campo escalar de `Ticket` por el que agrupa `groupBy`. */
  campo:
    | 'idUsuario'
    | 'idAtraccion'
    | 'idOrigen'
    | 'idPais'
    | 'idTipoRecorrido'
    | 'idGuia';
  etiquetaColumna: string;
  /** Plural de la etiqueta, escrito y no derivado: en español no basta con una 's'. */
  etiquetaPlural: string;
  /** Texto para las filas cuya FK es nula (país en ventas nacionales, guía ausente). */
  etiquetaNula: string;
  resolverNombres(
    prisma: PrismaService,
    ids: number[],
  ): Promise<Map<number, string>>;
}

/** Catálogos pequeños: una sola consulta con los ids que de verdad aparecieron. */
async function nombresDe(
  consultar: (ids: number[]) => Promise<Array<{ id: number; nombre: string }>>,
  ids: number[],
): Promise<Map<number, string>> {
  const limpios = ids.filter((id): id is number => typeof id === 'number');
  if (limpios.length === 0) return new Map();
  const filas = await consultar(limpios);
  return new Map(filas.map((f) => [f.id, f.nombre]));
}

export const DIMENSIONES: Readonly<Record<ClaveDimension, Dimension>> = {
  vendedor: {
    campo: 'idUsuario',
    etiquetaColumna: 'Vendedor',
    etiquetaPlural: 'vendedores',
    etiquetaNula: 'Sin vendedor',
    resolverNombres: (prisma, ids) =>
      nombresDe(
        (limpios) =>
          prisma.usuario.findMany({
            where: { id: { in: limpios } },
            select: { id: true, nombre: true },
          }),
        ids,
      ),
  },
  atraccion: {
    campo: 'idAtraccion',
    etiquetaColumna: 'Atracción',
    etiquetaPlural: 'atracciones',
    etiquetaNula: 'Sin atracción',
    resolverNombres: (prisma, ids) =>
      nombresDe(
        (limpios) =>
          prisma.atraccion.findMany({
            where: { id: { in: limpios } },
            select: { id: true, nombre: true },
          }),
        ids,
      ),
  },
  origen: {
    campo: 'idOrigen',
    etiquetaColumna: 'Origen',
    etiquetaPlural: 'orígenes',
    etiquetaNula: 'Sin origen',
    resolverNombres: (prisma, ids) =>
      nombresDe(
        (limpios) =>
          prisma.origenVisitante.findMany({
            where: { id: { in: limpios } },
            select: { id: true, nombre: true },
          }),
        ids,
      ),
  },
  pais: {
    campo: 'idPais',
    etiquetaColumna: 'País',
    etiquetaPlural: 'países',
    // `idPais` es nulo en toda venta nacional, y esas filas deben salir en el reporte.
    etiquetaNula: 'Nacional / sin país',
    resolverNombres: (prisma, ids) =>
      nombresDe(
        (limpios) =>
          prisma.pais.findMany({
            where: { id: { in: limpios } },
            select: { id: true, nombre: true },
          }),
        ids,
      ),
  },
  tipoRecorrido: {
    campo: 'idTipoRecorrido',
    etiquetaColumna: 'Recorrido',
    etiquetaPlural: 'recorridos',
    etiquetaNula: 'Sin recorrido',
    resolverNombres: (prisma, ids) =>
      nombresDe(
        (limpios) =>
          prisma.tipoRecorrido.findMany({
            where: { id: { in: limpios } },
            select: { id: true, nombre: true },
          }),
        ids,
      ),
  },
  guia: {
    campo: 'idGuia',
    etiquetaColumna: 'Guía',
    etiquetaPlural: 'guías',
    // Nulo cuando el grupo entró sin guía; es una categoría con significado propio.
    etiquetaNula: 'Sin guía',
    resolverNombres: (prisma, ids) =>
      nombresDe(
        (limpios) =>
          prisma.guia.findMany({
            where: { id: { in: limpios } },
            select: { id: true, nombre: true },
          }),
        ids,
      ),
  },
};

export function esDimensionValida(valor: unknown): valor is ClaveDimension {
  return (
    typeof valor === 'string' &&
    Object.prototype.hasOwnProperty.call(DIMENSIONES, valor)
  );
}

/**
 * Las claves de dimensión como arreglo, para el DTO y el esquema de la IA.
 *
 * Se derivan del objeto y no se escriben aparte: una dimensión nueva queda
 * admitida en la validación y ofrecida a la IA sin tocar nada más.
 */
export const CLAVES_DIMENSION = Object.keys(DIMENSIONES) as ClaveDimension[];

/** Qué se puede medir en un desglose. */
export const METRICAS = ['total', 'tickets', 'personas'] as const;
export type Metrica = (typeof METRICAS)[number];

/** Etiqueta de columna y formato de cada métrica. */
export const ETIQUETA_METRICA: Record<Metrica, string> = {
  total: 'Total',
  tickets: 'Tickets',
  personas: 'Personas',
};

// ---------------------------------------------------------------------------
// Agrupaciones por tiempo
// ---------------------------------------------------------------------------

/**
 * Cortes temporales por los que se puede desglosar una venta.
 *
 * No son FK, así que `groupBy` de Prisma no las alcanza: hay que truncar la
 * fecha en SQL. Cada una lleva su fragmento como `Prisma.Sql` **literal**, no
 * como texto que se concatene: la clave que llega del cliente o de la IA solo
 * indexa este objeto, igual que en `DIMENSIONES`, así que nada de lo que
 * escriba un usuario llega nunca a la consulta.
 *
 * Existen porque sin ellas la pregunta más común del parque —«cuántos tickets
 * en agosto y en septiembre»— no tenía respuesta: el sistema solo sabía
 * desglosar por día, y devolvía las dos cosas mezcladas.
 */
export type ClaveTiempo = 'dia' | 'semana' | 'mes' | 'diaSemana' | 'horaDelDia';

export interface DimensionTiempo {
  /** Expresión que va en el SELECT y en el GROUP BY. */
  expresion: Prisma.Sql;
  etiquetaColumna: string;
  etiquetaPlural: string;
  formato: 'texto' | 'fecha';
  /** Orden natural: cronológico salvo que se pida un top N. */
  cronologico: true;
  /** Convierte la clave cruda de SQL en lo que lee una persona. */
  presentar(valor: string): string;
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * 0 = domingo. El índice es el que produce la expresión SQL, que se calcula sin
 * depender de @@DATEFIRST del servidor.
 */
export const DIAS_SEMANA = [
  'domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado',
];

/** Sin tildes ni mayúsculas, que es como se escriben en una petición. */
export const DIAS_SEMANA_CLAVE = DIAS_SEMANA.map((dia) =>
  dia.normalize('NFD').replace(/[̀-ͯ]/g, ''),
);

/** Índice 0-6 de un día escrito como sea, o null si no es un día. */
export function indiceDiaSemana(valor: string): number | null {
  const limpio = valor
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const indice = DIAS_SEMANA_CLAVE.indexOf(limpio);
  return indice >= 0 ? indice : null;
}

export const DIMENSIONES_TIEMPO: Readonly<Record<ClaveTiempo, DimensionTiempo>> = {
  dia: {
    expresion: Prisma.sql`CONVERT(char(10), t.fechaCreacion, 23)`,
    etiquetaColumna: 'Día',
    etiquetaPlural: 'días',
    formato: 'fecha',
    cronologico: true,
    presentar: (valor) => valor,
  },
  semana: {
    // Semana ISO: no depende de la configuración regional del servidor.
    expresion: Prisma.sql`CONCAT(DATEPART(year, t.fechaCreacion), '-S', RIGHT(CONCAT('0', DATEPART(iso_week, t.fechaCreacion)), 2))`,
    etiquetaColumna: 'Semana',
    etiquetaPlural: 'semanas',
    formato: 'texto',
    cronologico: true,
    presentar: (valor) => `Semana ${valor.slice(6)} de ${valor.slice(0, 4)}`,
  },
  mes: {
    // Estilo 126 es ISO 8601; recortado a 7 caracteres da 'AAAA-MM'.
    expresion: Prisma.sql`CONVERT(char(7), t.fechaCreacion, 126)`,
    etiquetaColumna: 'Mes',
    etiquetaPlural: 'meses',
    formato: 'texto',
    cronologico: true,
    presentar: (valor) => {
      const [anio, mes] = valor.split('-');
      const nombre = MESES[Number(mes) - 1];
      return nombre ? `${nombre[0].toUpperCase()}${nombre.slice(1)} ${anio}` : valor;
    },
  },
  diaSemana: {
    // (dw + @@DATEFIRST - 1) % 7 da 0=domingo pase lo que pase en el servidor.
    expresion: Prisma.sql`CAST((DATEPART(weekday, t.fechaCreacion) + @@DATEFIRST - 1) % 7 AS varchar(1))`,
    etiquetaColumna: 'Día de la semana',
    etiquetaPlural: 'días de la semana',
    formato: 'texto',
    cronologico: true,
    presentar: (valor) => {
      const nombre = DIAS_SEMANA[Number(valor)];
      return nombre ? `${nombre[0].toUpperCase()}${nombre.slice(1)}` : valor;
    },
  },
  horaDelDia: {
    expresion: Prisma.sql`RIGHT(CONCAT('0', DATEPART(hour, t.fechaCreacion)), 2)`,
    etiquetaColumna: 'Hora',
    etiquetaPlural: 'horas',
    formato: 'texto',
    cronologico: true,
    presentar: (valor) => `${valor}:00`,
  },
};

export const CLAVES_TIEMPO = Object.keys(DIMENSIONES_TIEMPO) as ClaveTiempo[];

/** Todo lo que puede ir en `dimension`: catálogos y cortes de tiempo. */
export type ClaveAgrupacion = ClaveDimension | ClaveTiempo;
export const CLAVES_AGRUPACION: ClaveAgrupacion[] = [
  ...CLAVES_DIMENSION,
  ...CLAVES_TIEMPO,
];

export function esClaveTiempo(valor: unknown): valor is ClaveTiempo {
  return (
    typeof valor === 'string' &&
    Object.prototype.hasOwnProperty.call(DIMENSIONES_TIEMPO, valor)
  );
}

export function esAgrupacionValida(valor: unknown): valor is ClaveAgrupacion {
  return esDimensionValida(valor) || esClaveTiempo(valor);
}

/** Etiquetas de cualquier agrupación, sea de catálogo o de tiempo. */
export function etiquetasDe(clave: ClaveAgrupacion): {
  columna: string;
  plural: string;
} {
  const tiempo = esClaveTiempo(clave) ? DIMENSIONES_TIEMPO[clave] : null;
  const dim = tiempo ?? DIMENSIONES[clave as ClaveDimension];
  return { columna: dim.etiquetaColumna, plural: dim.etiquetaPlural };
}
