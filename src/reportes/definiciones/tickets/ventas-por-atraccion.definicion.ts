import { DefinicionReporte } from '../../contratos';
import { metricasVentas } from '../../consultas/ventas.consulta';
import {
  FILTROS_VENTAS,
  NOTA_ANULADOS,
  kpiEntero,
  kpiMoneda,
  periodoDe,
} from '../comunes';
import { seccionPorDimension } from './seccion-dimension';

/**
 * Cuevas contra mariposario. Lleva además el desglose por tipo de recorrido, porque las
 * dos preguntas se hacen juntas: qué atracción vende más y con qué duración de visita.
 */
export const ventasPorAtraccion: DefinicionReporte = {
  clave: 'ventas-por-atraccion',
  titulo: 'Ventas por atracción',
  descripcion:
    'Comparación de lo recaudado en cada atracción del parque (cuevas, mariposario) ' +
    'durante el período, con un segundo desglose por tipo de recorrido (corto o largo). ' +
    'Responde a preguntas sobre ubicación, lugar o atracción visitada.',
  categoria: 'Tickets',
  moduloOrigen: 'EmisionTickets',
  orientacionSugerida: 'vertical',
  filtros: FILTROS_VENTAS,

  async ejecutar({ prisma, filtros }) {
    const [metricas, porAtraccion, porRecorrido] = await Promise.all([
      metricasVentas(prisma, filtros),
      seccionPorDimension(prisma, 'atraccion', filtros, 'Por atracción'),
      seccionPorDimension(
        prisma,
        'tipoRecorrido',
        filtros,
        'Por tipo de recorrido',
      ),
    ]);

    return {
      titulo: 'Ventas por atracción',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiMoneda('Recaudado', metricas.recaudado),
        kpiEntero('Personas', metricas.personas),
        kpiEntero('Atracciones con venta', porAtraccion.filas.length),
      ],
      secciones: [porAtraccion, porRecorrido],
      orientacion: 'vertical',
      notas: [NOTA_ANULADOS],
    };
  },
};
