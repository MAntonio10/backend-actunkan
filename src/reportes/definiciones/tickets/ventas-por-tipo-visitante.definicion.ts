import { DefinicionReporte, FilaReporte } from '../../contratos';
import {
  metricasVentas,
  ventasPorTipoVisitante,
} from '../../consultas/ventas.consulta';
import {
  COLUMNA_PARTICIPACION,
  FILTROS_VENTAS,
  NOTA_ANULADOS,
  conParticipacion,
  kpiEntero,
  kpiMoneda,
  periodoDe,
  totalesDe,
} from '../comunes';

const COLUMNAS = [
  {
    clave: 'tipoVisitante',
    titulo: 'Categoría',
    formato: 'texto' as const,
    ancho: 0.34,
  },
  {
    clave: 'personas',
    titulo: 'Personas',
    formato: 'entero' as const,
    total: 'suma' as const,
  },
  {
    clave: 'subtotal',
    titulo: 'Subtotal',
    formato: 'moneda' as const,
    total: 'suma' as const,
  },
  COLUMNA_PARTICIPACION,
];

/**
 * Cuántos adultos, niños y centros educativos entraron, y cuánto aportó cada categoría.
 *
 * Agrega `VisitantePorTicket`, que es donde vive el desglose real de cada venta con el
 * precio congelado al momento de cobrar.
 */
export const ventasPorTipoDeVisitante: DefinicionReporte = {
  clave: 'ventas-por-tipo-visitante',
  titulo: 'Ventas por tipo de visitante',
  descripcion:
    'Cuántas personas de cada categoría ingresaron y cuánto aportó cada una: adultos, ' +
    'niños, niños menores y centros educativos. Responde a preguntas sobre categorías, ' +
    'tipos de entrada, adultos contra niños, o composición del público.',
  categoria: 'Tickets',
  moduloOrigen: 'EmisionTickets',
  orientacionSugerida: 'vertical',
  filtros: FILTROS_VENTAS,

  async ejecutar({ prisma, filtros }) {
    const [metricas, desglose] = await Promise.all([
      metricasVentas(prisma, filtros),
      ventasPorTipoVisitante(prisma, filtros),
    ]);

    const filas = conParticipacion(
      desglose as unknown as FilaReporte[],
      'subtotal',
    );

    return {
      titulo: 'Ventas por tipo de visitante',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiEntero('Personas', metricas.personas),
        kpiEntero('Categorías con venta', filas.length),
        kpiMoneda('Recaudado (total)', metricas.recaudado),
      ],
      secciones: [
        {
          columnas: COLUMNAS,
          filas,
          totales: totalesDe(COLUMNAS, filas),
        },
      ],
      orientacion: 'vertical',
      notas: [
        NOTA_ANULADOS,
        'El subtotal por categoría no incluye los tickets independientes de guía, que no ' +
          'se desglosan por tipo de visitante. Por eso la suma de esta tabla puede ser ' +
          'menor que el recaudado total del período.',
      ],
    };
  },
};
