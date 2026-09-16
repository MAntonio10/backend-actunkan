import { DefinicionReporte, FilaReporte } from '../../contratos';
import { metricasVentas, whereVentas } from '../../consultas/ventas.consulta';
import { aDecimal } from '../../formato.util';
import {
  FILTROS_VENTAS,
  NOTA_ANULADOS,
  NOTA_FECHA_VENTA,
  fechaHora,
  kpiEntero,
  kpiMoneda,
  periodoDe,
  recortar,
  totalesDe,
} from '../comunes';

const COLUMNAS = [
  {
    clave: 'numeroTicket',
    titulo: 'Folio',
    formato: 'texto' as const,
    anchoMinimo: 80,
  },
  {
    clave: 'fecha',
    titulo: 'Fecha',
    formato: 'fechaHora' as const,
    anchoMinimo: 92,
  },
  { clave: 'nombre', titulo: 'Grupo', formato: 'texto' as const, ancho: 0.16 },
  {
    clave: 'vendedor',
    titulo: 'Vendedor',
    formato: 'texto' as const,
    ancho: 0.12,
  },
  {
    clave: 'atraccion',
    titulo: 'Atracción',
    formato: 'texto' as const,
    ancho: 0.1,
  },
  {
    clave: 'recorrido',
    titulo: 'Recorrido',
    formato: 'texto' as const,
    ancho: 0.09,
  },
  { clave: 'origen', titulo: 'Origen', formato: 'texto' as const, ancho: 0.08 },
  { clave: 'pais', titulo: 'País', formato: 'texto' as const, ancho: 0.09 },
  { clave: 'guia', titulo: 'Guía', formato: 'texto' as const, ancho: 0.1 },
  {
    clave: 'personas',
    titulo: 'Pers.',
    formato: 'entero' as const,
    total: 'suma' as const,
    anchoMinimo: 42,
  },
  {
    clave: 'monto',
    titulo: 'Monto',
    formato: 'moneda' as const,
    total: 'suma' as const,
    anchoMinimo: 70,
  },
];

/**
 * El libro de ventas: un renglón por ticket emitido.
 *
 * Es el reporte con más filas del módulo junto con la bitácora, así que respeta el tope
 * que le impone el servicio según el formato de salida y avisa cuando recorta.
 */
export const ventasDetalle: DefinicionReporte = {
  clave: 'ventas-detalle',
  titulo: 'Detalle de ventas',
  descripcion:
    'Listado completo de los tickets emitidos en el período, un renglón por ticket, con ' +
    'folio, fecha, grupo, vendedor, atracción, recorrido, origen, país, guía, personas y ' +
    'monto. Es el libro de ventas; sirve cuando se pide el detalle, el listado o el ' +
    'desglose ticket por ticket en vez de un resumen agregado.',
  categoria: 'Tickets',
  moduloOrigen: 'EmisionTickets',
  // Once columnas de las que cinco son texto: en vertical no cabe.
  orientacionSugerida: 'horizontal',
  filtros: FILTROS_VENTAS,

  async ejecutar({ prisma, filtros, limiteFilas }) {
    const [metricas, tickets] = await Promise.all([
      metricasVentas(prisma, filtros),
      prisma.ticket.findMany({
        where: whereVentas(filtros),
        orderBy: { fechaCreacion: 'desc' },
        // Se pide una fila más que el tope para saber si hubo recorte sin un count aparte.
        take: limiteFilas + 1,
        select: {
          numeroTicket: true,
          fechaCreacion: true,
          nombre: true,
          cantidadPersonas: true,
          montoTotal: true,
          usuario: { select: { nombre: true } },
          atraccion: { select: { nombre: true } },
          tipoRecorrido: { select: { nombre: true } },
          origen: { select: { nombre: true } },
          pais: { select: { nombre: true } },
          guia: { select: { nombre: true } },
        },
      }),
    ]);

    const { filas: pagina, disponibles } = recortar(tickets, limiteFilas);

    const filas: FilaReporte[] = pagina.map((ticket) => ({
      numeroTicket: ticket.numeroTicket,
      fecha: fechaHora(ticket.fechaCreacion),
      nombre: ticket.nombre,
      vendedor: ticket.usuario?.nombre ?? null,
      atraccion: ticket.atraccion?.nombre ?? null,
      recorrido: ticket.tipoRecorrido?.nombre ?? null,
      origen: ticket.origen?.nombre ?? null,
      pais: ticket.pais?.nombre ?? null,
      guia: ticket.guia?.nombre ?? null,
      personas: ticket.cantidadPersonas,
      monto: aDecimal(ticket.montoTotal).toFixed(4),
    }));

    return {
      titulo: 'Detalle de ventas',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiMoneda('Recaudado', metricas.recaudado),
        kpiEntero('Tickets', metricas.tickets),
        kpiEntero('Personas', metricas.personas),
      ],
      secciones: [
        {
          columnas: COLUMNAS,
          filas,
          // Los totales describen lo que se está mostrando; el recaudado del período
          // completo va en el KPI de arriba.
          totales: totalesDe(COLUMNAS, filas),
          filasDisponibles: Math.min(disponibles, metricas.tickets),
        },
      ],
      orientacion: 'horizontal',
      notas: [NOTA_ANULADOS, NOTA_FECHA_VENTA],
    };
  },
};
