import { Prisma } from '@prisma/client';
import {
  ColumnaReporte,
  EsquemaFiltro,
  FilaReporte,
  FiltrosResueltos,
  KpiReporte,
} from '../contratos';
import { porcentajeDe, separarMiles } from '../formato.util';

/**
 * Piezas que repiten casi todas las definiciones: esquemas de filtro, columnas de uso
 * común y armadores de KPI. Están aquí para que dos reportes no escriban la misma
 * etiqueta de dos maneras distintas.
 */

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

export const FILTRO_PERIODO: EsquemaFiltro = {
  clave: 'periodo',
  etiqueta: 'Período',
  tipo: 'rangoFechas',
  descripcion:
    'Rango de fechas del reporte, ambas inclusive. Si el usuario no lo dice, usar el mes en curso.',
  requerido: true,
};

export const FILTRO_VENDEDOR: EsquemaFiltro = {
  clave: 'vendedor',
  etiqueta: 'Vendedor',
  tipo: 'usuario',
  descripcion: 'Nombre del cajero o usuario que emitió la venta.',
};

export const FILTRO_ATRACCION: EsquemaFiltro = {
  clave: 'atraccion',
  etiqueta: 'Atracción',
  tipo: 'atraccion',
  descripcion: 'Atracción visitada: cuevas o mariposario.',
};

export const FILTRO_ORIGEN: EsquemaFiltro = {
  clave: 'origen',
  etiqueta: 'Origen',
  tipo: 'origen',
  descripcion: 'Procedencia del visitante: nacional o extranjero.',
};

export const FILTRO_PAIS: EsquemaFiltro = {
  clave: 'pais',
  etiqueta: 'País',
  tipo: 'pais',
  descripcion: 'País del visitante extranjero.',
};

export const FILTRO_GUIA: EsquemaFiltro = {
  clave: 'guia',
  etiqueta: 'Guía',
  tipo: 'guia',
  descripcion: 'Guía que acompañó al grupo.',
};

export const FILTRO_TIPO_RECORRIDO: EsquemaFiltro = {
  clave: 'tipoRecorrido',
  etiqueta: 'Recorrido',
  tipo: 'tipoRecorrido',
  descripcion: 'Tipo de recorrido contratado: corto o largo.',
};

export const FILTRO_FORMA_PAGO: EsquemaFiltro = {
  clave: 'formaPago',
  etiqueta: 'Forma de pago',
  tipo: 'opcionPago',
  descripcion: 'Forma de pago con la que se cobró: efectivo o tarjeta.',
};

/** Los filtros que aceptan todos los reportes de ventas. */
export const FILTROS_VENTAS: EsquemaFiltro[] = [
  FILTRO_PERIODO,
  FILTRO_VENDEDOR,
  FILTRO_ATRACCION,
  FILTRO_ORIGEN,
  FILTRO_PAIS,
  FILTRO_GUIA,
  FILTRO_TIPO_RECORRIDO,
  FILTRO_FORMA_PAGO,
];

// ---------------------------------------------------------------------------
// Columnas
// ---------------------------------------------------------------------------

export const COLUMNA_TICKETS: ColumnaReporte = {
  clave: 'tickets',
  titulo: 'Tickets',
  formato: 'entero',
  total: 'suma',
  anchoMinimo: 55,
};

export const COLUMNA_PERSONAS: ColumnaReporte = {
  clave: 'personas',
  titulo: 'Personas',
  formato: 'entero',
  total: 'suma',
  anchoMinimo: 60,
};

export const COLUMNA_TOTAL: ColumnaReporte = {
  clave: 'total',
  titulo: 'Total',
  formato: 'moneda',
  total: 'suma',
  anchoMinimo: 75,
};

export const COLUMNA_PARTICIPACION: ColumnaReporte = {
  clave: 'participacion',
  titulo: '% del total',
  formato: 'porcentaje',
  anchoMinimo: 60,
};

// ---------------------------------------------------------------------------
// Ayudantes
// ---------------------------------------------------------------------------

/** Monto legible para incrustarlo en el detalle de un KPI o en un subtítulo. */
export function montoLegible(valor: Prisma.Decimal): string {
  return `Q${separarMiles(valor.toFixed(2))}`;
}

/** KPI de dinero, con el mismo formato en todos los reportes. */
export function kpiMoneda(
  etiqueta: string,
  valor: Prisma.Decimal,
  detalle?: string,
): KpiReporte {
  return { etiqueta, valor: montoLegible(valor), detalle };
}

export function kpiEntero(
  etiqueta: string,
  valor: number,
  detalle?: string,
): KpiReporte {
  return { etiqueta, valor: separarMiles(String(Math.trunc(valor))), detalle };
}

/**
 * Agrega la columna de participación a un desglose ya calculado.
 *
 * El porcentaje se calcula sobre el total del propio desglose y no sobre el recaudado
 * general del período: si no, un reporte filtrado por atracción mostraría porcentajes
 * que no suman 100 y parecería que faltan filas.
 */
export function conParticipacion(
  filas: FilaReporte[],
  claveValor = 'total',
): FilaReporte[] {
  const total = filas.reduce(
    (acumulado, fila) =>
      acumulado.plus(new Prisma.Decimal(String(fila[claveValor] ?? 0))),
    new Prisma.Decimal(0),
  );

  return filas.map((fila) => ({
    ...fila,
    participacion: porcentajeDe(String(fila[claveValor] ?? 0), total),
  }));
}

/** Fila de totales sumando las columnas que lo declaran. */
export function totalesDe(
  columnas: ColumnaReporte[],
  filas: FilaReporte[],
): FilaReporte {
  const totales: FilaReporte = {};

  for (const columna of columnas) {
    if (columna.total === 'suma') {
      const suma = filas.reduce(
        (acumulado, fila) =>
          acumulado.plus(new Prisma.Decimal(String(fila[columna.clave] ?? 0))),
        new Prisma.Decimal(0),
      );
      totales[columna.clave] = suma.toFixed(
        columna.formato === 'entero' ? 0 : 4,
      );
    } else if (columna.total === 'conteo') {
      totales[columna.clave] = filas.length;
    }
  }

  return totales;
}

/**
 * Recorta el listado al tope que fijó el servicio y avisa cuántas filas había.
 *
 * El tope depende del formato de salida: un PDF de 100 000 filas revienta la memoria
 * del proceso, mientras que un Excel las aguanta sin despeinarse.
 */
export function recortar<T>(
  filas: T[],
  limite: number,
): { filas: T[]; disponibles: number } {
  if (filas.length <= limite) return { filas, disponibles: filas.length };
  return { filas: filas.slice(0, limite), disponibles: filas.length };
}

/** Etiqueta ISO de fecha sin la parte de hora, para las celdas de tipo fecha. */
export function soloFecha(fecha: Date | null | undefined): string | null {
  return fecha ? fecha.toISOString().slice(0, 10) : null;
}

/** Fecha con hora, en el formato que espera el renderizador. */
export function fechaHora(fecha: Date | null | undefined): string | null {
  return fecha ? fecha.toISOString().slice(0, 16).replace('T', ' ') : null;
}

/** Nota que llevan todos los reportes de venta sobre a qué día se imputa una venta. */
export const NOTA_FECHA_VENTA =
  'Las ventas se imputan por su fecha de registro en el servidor, igual que el historial ' +
  'de tickets y el arqueo de caja. Una venta offline subida al día siguiente cuenta en el ' +
  'día en que se subió.';

export const NOTA_ANULADOS =
  'Los tickets anulados nunca suman al recaudado: no cobraron nada ni dieron acceso, y ya ' +
  'salieron del arqueo de su caja. Se reportan por separado.';

/** Bloque de período que llevan todos los reportes con rango de fechas. */
export function periodoDe(filtros: FiltrosResueltos) {
  return {
    desde: filtros.desdeIso,
    hasta: filtros.hastaIso,
    etiqueta: filtros.etiquetaPeriodo,
  };
}
