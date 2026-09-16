import { DefinicionReporte, FilaReporte } from '../../contratos';
import { aDecimal } from '../../formato.util';
import {
  FILTRO_PERIODO,
  FILTRO_VENDEDOR,
  fechaHora,
  kpiEntero,
  kpiMoneda,
  periodoDe,
  recortar,
  totalesDe,
} from '../comunes';

const COLUMNAS = [
  {
    clave: 'numeroRecibo',
    titulo: 'Recibo',
    formato: 'texto' as const,
    anchoMinimo: 95,
  },
  {
    clave: 'fecha',
    titulo: 'Fecha',
    formato: 'fechaHora' as const,
    anchoMinimo: 95,
  },
  {
    clave: 'donante',
    titulo: 'Donante',
    formato: 'texto' as const,
    ancho: 0.26,
  },
  {
    clave: 'usuario',
    titulo: 'Recibió',
    formato: 'texto' as const,
    ancho: 0.18,
  },
  {
    clave: 'caja',
    titulo: 'Caja',
    formato: 'entero' as const,
    anchoMinimo: 40,
  },
  {
    clave: 'estado',
    titulo: 'Estado',
    formato: 'texto' as const,
    anchoMinimo: 60,
  },
  {
    clave: 'monto',
    titulo: 'Monto',
    formato: 'moneda' as const,
    total: 'suma' as const,
  },
];

/**
 * Listado de recibos de donación, uno por fila.
 *
 * Incluye los anulados: es un reporte de control y ocultarlos escondería justo lo que se
 * quiere revisar. Pero el total solo suma los vigentes, y el estado va en su columna.
 */
export const donacionesDetalle: DefinicionReporte = {
  clave: 'donaciones-detalle',
  titulo: 'Detalle de donaciones',
  descripcion:
    'Listado de los recibos de donación del período, con folio, fecha, donante, quién la ' +
    'recibió, a qué caja entró, estado y monto. Incluye los recibos anulados marcados ' +
    'como tales. Sirve cuando se pide el detalle o el listado de donaciones.',
  categoria: 'Donaciones',
  moduloOrigen: 'Donaciones',
  orientacionSugerida: 'vertical',
  filtros: [
    FILTRO_PERIODO,
    {
      ...FILTRO_VENDEDOR,
      etiqueta: 'Recibió',
      descripcion: 'Usuario que registró la donación.',
    },
  ],

  async ejecutar({ prisma, filtros, limiteFilas }) {
    const donaciones = await prisma.donacion.findMany({
      where: {
        fechaCreacion: { gte: filtros.desde, lt: filtros.hasta },
        ...(filtros.idUsuario ? { idUsuario: filtros.idUsuario } : {}),
      },
      orderBy: { fechaCreacion: 'desc' },
      take: limiteFilas + 1,
      select: {
        numeroRecibo: true,
        fechaCreacion: true,
        nombreDonante: true,
        monto: true,
        anulado: true,
        motivoAnulacion: true,
        idAperturaCaja: true,
        usuario: { select: { nombre: true } },
      },
    });

    const { filas: pagina, disponibles } = recortar(donaciones, limiteFilas);

    const filas: FilaReporte[] = pagina.map((donacion) => ({
      numeroRecibo: donacion.numeroRecibo,
      fecha: fechaHora(donacion.fechaCreacion),
      // La donación anónima es válida y se registra sin nombre.
      donante: donacion.nombreDonante ?? 'Donante anónimo',
      usuario: donacion.usuario?.nombre ?? null,
      caja: donacion.idAperturaCaja,
      estado: donacion.anulado
        ? `Anulado${donacion.motivoAnulacion ? `: ${donacion.motivoAnulacion}` : ''}`
        : 'Vigente',
      // Solo el vigente lleva monto en la columna que se totaliza: así el total del pie
      // es el recaudado real y no una suma que incluye lo que se dio de baja.
      monto: donacion.anulado ? null : aDecimal(donacion.monto).toFixed(4),
    }));

    const totales = totalesDe(COLUMNAS, filas);
    const anulados = filas.filter((fila) => fila.monto === null).length;

    return {
      titulo: 'Detalle de donaciones',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiEntero('Recibos', filas.length),
        kpiEntero('Anulados', anulados),
        kpiMoneda('Recaudado', aDecimal(totales.monto as string)),
      ],
      secciones: [
        {
          columnas: COLUMNAS,
          filas,
          totales,
          filasDisponibles: disponibles,
        },
      ],
      orientacion: 'vertical',
      notas: [
        'Los recibos anulados aparecen en el listado sin monto: se muestran para poder ' +
          'auditarlos, pero no suman al recaudado.',
        'El recibo de donación es un documento no contable y no tiene validez fiscal.',
      ],
    };
  },
};
