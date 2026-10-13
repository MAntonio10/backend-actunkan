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
 * Cuánto vendió cada cajero. El "vendedor" del negocio es el `Usuario` que emitió el
 * ticket, no una entidad aparte.
 */
export const ventasPorVendedor: DefinicionReporte = {
  // La clave no cambia: viaja en la URL del reporte y queda escrita en la bitácora
  // de cada generación y exportación, que es registro de auditoría.
  clave: 'ventas-por-vendedor',
  titulo: 'Recaudación por colaborador',
  descripcion:
    'Cuánto vendió cada colaborador: tickets, personas atendidas, total y qué ' +
    'porcentaje representa.',
  pistasIa:
    'Sirve para comparar el desempeño entre quienes atienden taquilla. Al ' +
    'colaborador se le decía «vendedor»: «ventas por vendedor» y «recaudación por ' +
    'colaborador» piden este mismo reporte.',
  categoria: 'Tickets',
  moduloOrigen: 'EmisionTickets',
  orientacionSugerida: 'vertical',
  filtros: FILTROS_VENTAS,

  async ejecutar({ prisma, filtros }) {
    const [metricas, seccion] = await Promise.all([
      metricasVentas(prisma, filtros),
      seccionPorDimension(prisma, 'vendedor', filtros),
    ]);

    return {
      titulo: 'Recaudación por colaborador',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiMoneda('Recaudado', metricas.recaudado),
        kpiEntero('Tickets emitidos', metricas.tickets),
        kpiEntero('Colaboradores', seccion.filas.length),
        kpiMoneda('Ticket promedio', metricas.ticketPromedio),
      ],
      secciones: [seccion],
      orientacion: 'vertical',
      notas: [NOTA_ANULADOS],
    };
  },
};
