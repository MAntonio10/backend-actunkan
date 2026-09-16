import { DefinicionReporte, FilaReporte } from '../../contratos';
import { whereVentasAnuladas } from '../../consultas/ventas.consulta';
import { aDecimal } from '../../formato.util';
import {
  FILTROS_VENTAS,
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
    anchoMinimo: 85,
  },
  {
    clave: 'emitido',
    titulo: 'Emitido',
    formato: 'fechaHora' as const,
    anchoMinimo: 95,
  },
  {
    clave: 'anulado',
    titulo: 'Anulado',
    formato: 'fechaHora' as const,
    anchoMinimo: 95,
  },
  { clave: 'nombre', titulo: 'Grupo', formato: 'texto' as const, ancho: 0.2 },
  {
    clave: 'vendedor',
    titulo: 'Emitió',
    formato: 'texto' as const,
    ancho: 0.16,
  },
  {
    clave: 'atraccion',
    titulo: 'Atracción',
    formato: 'texto' as const,
    ancho: 0.12,
  },
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
 * Qué se anuló y por cuánto.
 *
 * Un ticket emitido no se edita, solo se anula: por eso las anulaciones son el punto de
 * control del módulo de emisión, y merecen un reporte propio en vez de una casilla en el
 * listado general.
 */
export const ticketsAnulados: DefinicionReporte = {
  clave: 'tickets-anulados',
  titulo: 'Tickets anulados',
  descripcion:
    'Listado de los tickets que se anularon en el período: folio, cuándo se emitió, ' +
    'cuándo se anuló, quién lo emitió y por cuánto monto. Sirve para controlar ' +
    'anulaciones, cancelaciones o ventas revertidas.',
  categoria: 'Tickets',
  moduloOrigen: 'EmisionTickets',
  orientacionSugerida: 'horizontal',
  filtros: FILTROS_VENTAS,

  async ejecutar({ prisma, filtros, limiteFilas }) {
    const anulados = await prisma.ticket.findMany({
      where: whereVentasAnuladas(filtros),
      orderBy: { fechaActualizacion: 'desc' },
      take: limiteFilas + 1,
      select: {
        numeroTicket: true,
        fechaCreacion: true,
        fechaActualizacion: true,
        nombre: true,
        cantidadPersonas: true,
        montoTotal: true,
        observaciones: true,
        usuario: { select: { nombre: true } },
        atraccion: { select: { nombre: true } },
      },
    });

    const { filas: pagina, disponibles } = recortar(anulados, limiteFilas);

    const filas: FilaReporte[] = pagina.map((ticket) => ({
      numeroTicket: ticket.numeroTicket,
      emitido: fechaHora(ticket.fechaCreacion),
      // La anulación es una baja lógica: no hay columna de fecha de anulación, y
      // `fechaActualizacion` es lo más cercano que existe.
      anulado: fechaHora(ticket.fechaActualizacion),
      nombre: ticket.nombre,
      vendedor: ticket.usuario?.nombre ?? null,
      atraccion: ticket.atraccion?.nombre ?? null,
      personas: ticket.cantidadPersonas,
      monto: aDecimal(ticket.montoTotal).toFixed(4),
    }));

    const totales = totalesDe(COLUMNAS, filas);

    return {
      titulo: 'Tickets anulados',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiEntero('Tickets anulados', filas.length),
        kpiMoneda('Monto anulado', aDecimal(totales.monto as string)),
      ],
      secciones: [
        {
          columnas: COLUMNAS,
          filas,
          totales,
          filasDisponibles: disponibles,
        },
      ],
      orientacion: 'horizontal',
      notas: [
        'La columna "Anulado" muestra la última modificación del ticket, que es cuando se ' +
          'dio de baja: el sistema no guarda una fecha de anulación aparte.',
        'Estos montos no forman parte del recaudado de ningún otro reporte.',
      ],
    };
  },
};
