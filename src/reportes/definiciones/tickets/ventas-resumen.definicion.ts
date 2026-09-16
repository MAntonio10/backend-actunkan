import { DefinicionReporte, FilaReporte } from '../../contratos';
import { metricasVentas, ventasPorDia } from '../../consultas/ventas.consulta';
import {
  COLUMNA_PERSONAS,
  COLUMNA_TICKETS,
  COLUMNA_TOTAL,
  FILTROS_VENTAS,
  NOTA_ANULADOS,
  NOTA_FECHA_VENTA,
  kpiEntero,
  kpiMoneda,
  montoLegible,
  periodoDe,
  totalesDe,
} from '../comunes';

const COLUMNAS = [
  { clave: 'dia', titulo: 'Día', formato: 'fecha' as const, ancho: 0.2 },
  COLUMNA_TICKETS,
  COLUMNA_PERSONAS,
  COLUMNA_TOTAL,
  {
    clave: 'promedio',
    titulo: 'Ticket promedio',
    formato: 'moneda' as const,
    anchoMinimo: 80,
  },
];

/**
 * El reporte de cabecera: cuánto se vendió en el período y cómo se repartió por día.
 * Es el que responde "cómo nos fue en agosto" sin pedirle al usuario que elija una
 * dimensión de desglose.
 */
export const ventasResumen: DefinicionReporte = {
  clave: 'ventas-resumen',
  titulo: 'Resumen de ventas',
  descripcion:
    'Panorama de las ventas de un período: total recaudado, tickets emitidos, personas ' +
    'que ingresaron y ticket promedio, con el desglose de una fila por día. Es el reporte ' +
    'general de ventas cuando no se pide un desglose concreto.',
  categoria: 'Tickets',
  moduloOrigen: 'EmisionTickets',
  orientacionSugerida: 'vertical',
  filtros: FILTROS_VENTAS,

  async ejecutar({ prisma, filtros }) {
    const [metricas, porDia] = await Promise.all([
      metricasVentas(prisma, filtros),
      ventasPorDia(prisma, filtros),
    ]);

    const filas: FilaReporte[] = porDia.map((dia) => ({
      dia: dia.dia,
      tickets: dia.tickets,
      personas: dia.personas,
      total: dia.total,
      // El promedio por día se calcula aquí y no en SQL: AVG() de SQL Server sobre
      // DECIMAL(18,4) devuelve DECIMAL(38,6) y arrastra ceros hasta la impresión.
      promedio:
        dia.tickets > 0 ? (Number(dia.total) / dia.tickets).toFixed(4) : '0',
    }));

    return {
      titulo: 'Resumen de ventas',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiMoneda('Recaudado', metricas.recaudado),
        kpiEntero('Tickets emitidos', metricas.tickets),
        kpiEntero('Personas', metricas.personas),
        kpiMoneda('Ticket promedio', metricas.ticketPromedio),
        kpiEntero(
          'Tickets anulados',
          metricas.ticketsAnulados,
          montoLegible(metricas.montoAnulado),
        ),
      ],
      secciones: [
        {
          titulo: 'Ventas por día',
          columnas: COLUMNAS,
          filas,
          // El promedio no se totaliza: promediar promedios no da el promedio general.
          totales: totalesDe(COLUMNAS, filas),
        },
      ],
      orientacion: 'vertical',
      notas: [NOTA_ANULADOS, NOTA_FECHA_VENTA],
    };
  },
};
