import { Prisma } from '@prisma/client';
import { DefinicionReporte, FilaReporte } from '../../contratos';
import { ventasPorFormaPago } from '../../consultas/ventas.consulta';
import {
  FILTROS_VENTAS,
  kpiEntero,
  kpiMoneda,
  periodoDe,
  totalesDe,
} from '../comunes';

const ESTADO_PAGADO = 'PAGADO';

const COLUMNAS = [
  {
    clave: 'formaPago',
    titulo: 'Forma de pago',
    formato: 'texto' as const,
    ancho: 0.3,
  },
  {
    clave: 'estadoPago',
    titulo: 'Estado',
    formato: 'texto' as const,
    ancho: 0.2,
  },
  {
    clave: 'pagos',
    titulo: 'Pagos',
    formato: 'entero' as const,
    total: 'suma' as const,
  },
  {
    clave: 'total',
    titulo: 'Monto',
    formato: 'moneda' as const,
    total: 'suma' as const,
  },
];

/**
 * Cómo se cobró: efectivo, tarjeta, y en qué estado quedó cada cobro.
 *
 * Los estados van en filas separadas y no sumados. Una tarjeta `PENDIENTE` es un cobro
 * que la pasarela todavía no confirmó; meterla en el mismo renglón que el efectivo
 * inflaría el ingreso con dinero que puede no llegar nunca.
 */
export const ventasPorFormaDePago: DefinicionReporte = {
  clave: 'ventas-por-forma-pago',
  titulo: 'Ventas por forma de pago',
  descripcion:
    'Cómo se cobraron las ventas del período: efectivo contra tarjeta, separando los ' +
    'pagos confirmados de los pendientes y los cancelados. Responde a preguntas sobre ' +
    'métodos de pago, cobros con tarjeta o cuánto entró en efectivo.',
  categoria: 'Tickets',
  moduloOrigen: 'EmisionTickets',
  orientacionSugerida: 'vertical',
  filtros: FILTROS_VENTAS,

  async ejecutar({ prisma, filtros }) {
    const desglose = await ventasPorFormaPago(prisma, filtros);
    const filas = desglose as unknown as FilaReporte[];

    const sumar = (incluir: (estado: string) => boolean) =>
      desglose
        .filter((fila) => incluir(fila.estadoPago))
        .reduce(
          (acumulado, fila) => acumulado.plus(new Prisma.Decimal(fila.total)),
          new Prisma.Decimal(0),
        );

    return {
      titulo: 'Ventas por forma de pago',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiMoneda(
          'Cobrado y confirmado',
          sumar((estado) => estado === ESTADO_PAGADO),
        ),
        kpiMoneda(
          'Pendiente o cancelado',
          sumar((estado) => estado !== ESTADO_PAGADO),
        ),
        kpiEntero(
          'Pagos registrados',
          desglose.reduce((total, fila) => total + fila.pagos, 0),
        ),
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
        'Un ticket puede llevar más de un pago, así que el número de pagos no tiene por ' +
          'qué coincidir con el número de tickets del período.',
        'Solo el estado PAGADO cuenta como dinero cobrado. La tarjeta nace PENDIENTE y ' +
          'pasa a PAGADO cuando la pasarela lo confirma.',
      ],
    };
  },
};
