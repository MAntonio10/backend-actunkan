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
  clave: 'ventas-por-vendedor',
  titulo: 'Ventas por vendedor',
  descripcion:
    'Cuánto vendió cada cajero o vendedor en el período: tickets emitidos, personas ' +
    'atendidas, total recaudado y qué porcentaje del total representa. Sirve para ' +
    'comparar el desempeño entre quienes atienden taquilla.',
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
      titulo: 'Ventas por vendedor',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiMoneda('Recaudado', metricas.recaudado),
        kpiEntero('Tickets emitidos', metricas.tickets),
        kpiEntero('Vendedores', seccion.filas.length),
        kpiMoneda('Ticket promedio', metricas.ticketPromedio),
      ],
      secciones: [seccion],
      orientacion: 'vertical',
      notas: [NOTA_ANULADOS],
    };
  },
};
