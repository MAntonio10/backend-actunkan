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
 * Turismo nacional contra receptivo, y de dónde viene el receptivo.
 *
 * El desglose por país incluye una fila "Nacional / sin país": `Ticket.idPais` es nulo en
 * toda venta nacional, y esconderla dejaría un reporte cuyo total no cuadra con el resto.
 */
export const ventasPorOrigen: DefinicionReporte = {
  clave: 'ventas-por-origen',
  titulo: 'Recaudación por origen del visitante',
  descripcion:
    'Reparto entre visitantes nacionales y extranjeros, con un segundo desglose por ' +
    'país de procedencia.',
  pistasIa:
    'Responde a preguntas sobre nacionalidad, procedencia, turismo extranjero o de ' +
    'qué países vienen los visitantes.',
  categoria: 'Tickets',
  moduloOrigen: 'EmisionTickets',
  orientacionSugerida: 'vertical',
  filtros: FILTROS_VENTAS,

  async ejecutar({ prisma, filtros }) {
    const [metricas, porOrigen, porPais] = await Promise.all([
      metricasVentas(prisma, filtros),
      seccionPorDimension(prisma, 'origen', filtros, 'Por origen'),
      seccionPorDimension(prisma, 'pais', filtros, 'Por país'),
    ]);

    return {
      titulo: 'Recaudación por origen del visitante',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiMoneda('Recaudado', metricas.recaudado),
        kpiEntero('Personas', metricas.personas),
        // Se descuenta la fila de nacionales, que no es un país.
        kpiEntero(
          'Países representados',
          Math.max(porPais.filas.length - 1, 0),
        ),
      ],
      secciones: [porOrigen, porPais],
      orientacion: 'vertical',
      notas: [
        NOTA_ANULADOS,
        'La recaudación nacional no lleva país registrado y aparece agrupada bajo ' +
          '"Nacional / sin país" en el segundo desglose.',
      ],
    };
  },
};
