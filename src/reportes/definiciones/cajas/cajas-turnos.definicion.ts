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

/**
 * Las columnas del arqueo van marcadas `soloSupervisor`.
 *
 * `ReportesService` las borra —del dato, no del dibujo— cuando quien pide el reporte no
 * tiene `Cajas.Editar`. Es el mismo control que defiende `/cajas`: quien cuenta el
 * efectivo no debe conocer el monto esperado, porque bastaría teclear esa cifra para que
 * ningún faltante saliera nunca a la luz. Sin esta marca, el módulo de reportes sería el
 * agujero por el que se pierde ese control.
 */
const COLUMNAS = [
  { clave: 'id', titulo: '#', formato: 'entero' as const, anchoMinimo: 32 },
  { clave: 'cajero', titulo: 'Cajero', formato: 'texto' as const, ancho: 0.18 },
  {
    clave: 'apertura',
    titulo: 'Apertura',
    formato: 'fechaHora' as const,
    anchoMinimo: 95,
  },
  {
    clave: 'cierre',
    titulo: 'Cierre',
    formato: 'fechaHora' as const,
    anchoMinimo: 95,
  },
  {
    clave: 'estado',
    titulo: 'Estado',
    formato: 'texto' as const,
    anchoMinimo: 55,
  },
  {
    clave: 'montoInicial',
    titulo: 'Inicial',
    formato: 'moneda' as const,
    total: 'suma' as const,
  },
  {
    clave: 'montoContado',
    titulo: 'Contado',
    formato: 'moneda' as const,
    total: 'suma' as const,
  },
  {
    clave: 'montoEsperado',
    titulo: 'Esperado',
    formato: 'moneda' as const,
    total: 'suma' as const,
    soloSupervisor: true,
  },
  {
    clave: 'diferencia',
    titulo: 'Diferencia',
    formato: 'moneda' as const,
    total: 'suma' as const,
    soloSupervisor: true,
  },
];

export const cajasTurnos: DefinicionReporte = {
  clave: 'cajas-turnos',
  titulo: 'Turnos de caja',
  descripcion:
    'Turnos de caja abiertos en el período: quién abrió, a qué hora abrió y cerró, con ' +
    'cuánto empezó y cuánto contó al cerrar. Para un supervisor incluye además el monto ' +
    'esperado y la diferencia de cada arqueo. Responde a preguntas sobre cajas, turnos, ' +
    'aperturas, cierres, cuadres, faltantes o sobrantes.',
  categoria: 'Cajas',
  moduloOrigen: 'Cajas',
  orientacionSugerida: 'horizontal',
  filtros: [
    FILTRO_PERIODO,
    {
      ...FILTRO_VENDEDOR,
      etiqueta: 'Cajero',
      descripcion: 'Usuario que abrió la caja.',
    },
  ],

  async ejecutar({ prisma, filtros, limiteFilas, esSupervisor }) {
    const aperturas = await prisma.aperturaCaja.findMany({
      where: {
        anulado: false,
        fechaCreacion: { gte: filtros.desde, lt: filtros.hasta },
        ...(filtros.idUsuario ? { idUsuario: filtros.idUsuario } : {}),
      },
      orderBy: { fechaCreacion: 'desc' },
      take: limiteFilas + 1,
      select: {
        id: true,
        montoInicial: true,
        fechaCreacion: true,
        usuario: { select: { nombre: true } },
        estado: { select: { nombre: true } },
        cierresCaja: {
          where: { anulado: false },
          orderBy: { fechaCierre: 'desc' },
          take: 1,
          select: {
            fechaCierre: true,
            montoFinal: true,
            montoEsperado: true,
            diferencia: true,
          },
        },
      },
    });

    const { filas: pagina, disponibles } = recortar(aperturas, limiteFilas);

    const filas: FilaReporte[] = pagina.map((apertura) => {
      const cierre = apertura.cierresCaja[0];
      return {
        id: apertura.id,
        cajero: apertura.usuario?.nombre ?? null,
        apertura: fechaHora(apertura.fechaCreacion),
        cierre: cierre ? fechaHora(cierre.fechaCierre) : null,
        estado: apertura.estado?.nombre ?? null,
        montoInicial: aDecimal(apertura.montoInicial).toFixed(4),
        montoContado: cierre ? aDecimal(cierre.montoFinal).toFixed(4) : null,
        montoEsperado: cierre?.montoEsperado
          ? aDecimal(cierre.montoEsperado).toFixed(4)
          : null,
        diferencia: cierre?.diferencia
          ? aDecimal(cierre.diferencia).toFixed(4)
          : null,
      };
    });

    const totales = totalesDe(COLUMNAS, filas);
    const abiertas = filas.filter((fila) => fila.cierre === null).length;

    const kpis = [
      kpiEntero('Turnos', filas.length),
      kpiEntero('Sin cerrar', abiertas),
      kpiMoneda('Total contado', aDecimal(totales.montoContado as string)),
      {
        ...kpiMoneda(
          'Diferencia acumulada',
          aDecimal(totales.diferencia as string),
        ),
        soloSupervisor: true,
      },
    ];

    return {
      titulo: 'Turnos de caja',
      subtitulo: esSupervisor
        ? undefined
        : 'Vista de cajero: sin cifras de arqueo',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis,
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
        'Una diferencia negativa es un faltante y una positiva un sobrante, respecto de lo ' +
          'que debería haber en el cajón.',
        'Un turno sin fecha de cierre sigue abierto, o su cierre fue anulado.',
      ],
    };
  },
};
