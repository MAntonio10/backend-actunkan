import { DefinicionReporte, FilaReporte } from '../../contratos';
import {
  FILTRO_PERIODO,
  FILTRO_VENDEDOR,
  kpiEntero,
  periodoDe,
  totalesDe,
} from '../comunes';

const COLUMNAS_MODULO = [
  { clave: 'modulo', titulo: 'Módulo', formato: 'texto' as const, ancho: 0.4 },
  {
    clave: 'acciones',
    titulo: 'Acciones',
    formato: 'entero' as const,
    total: 'suma' as const,
  },
];

const COLUMNAS_USUARIO = [
  {
    clave: 'usuario',
    titulo: 'Usuario',
    formato: 'texto' as const,
    ancho: 0.4,
  },
  {
    clave: 'acciones',
    titulo: 'Acciones',
    formato: 'entero' as const,
    total: 'suma' as const,
  },
];

const COLUMNAS_ACCION = [
  { clave: 'accion', titulo: 'Acción', formato: 'texto' as const, ancho: 0.4 },
  {
    clave: 'acciones',
    titulo: 'Veces',
    formato: 'entero' as const,
    total: 'suma' as const,
  },
];

/**
 * Quién hace qué: la bitácora contada en vez de listada.
 *
 * Nunca selecciona `descripcion`, que es `NVARCHAR(Max)`. Traerla para contar filas
 * dispararía lecturas LOB fuera de fila sin ningún beneficio.
 */
export const bitacoraResumen: DefinicionReporte = {
  clave: 'bitacora-resumen',
  titulo: 'Resumen de bitácora',
  descripcion:
    'Cuántas acciones se registraron en el período, agrupadas por módulo, por usuario y ' +
    'por tipo de acción. Responde a preguntas sobre actividad del sistema, quién trabajó ' +
    'más, o qué módulos se usan.',
  categoria: 'Bitácora',
  moduloOrigen: 'Bitacora',
  orientacionSugerida: 'vertical',
  filtros: [
    FILTRO_PERIODO,
    {
      ...FILTRO_VENDEDOR,
      etiqueta: 'Usuario',
      descripcion: 'Usuario que ejecutó las acciones.',
    },
    {
      clave: 'modulo',
      etiqueta: 'Módulo',
      tipo: 'modulo',
      descripcion: 'Módulo del sistema al que limitar el resumen.',
    },
  ],

  async ejecutar({ prisma, filtros }) {
    const where = {
      fecha: { gte: filtros.desde, lt: filtros.hasta },
      ...(filtros.idUsuario ? { idUsuario: filtros.idUsuario } : {}),
      ...(filtros.modulo ? { modulo: { contains: filtros.modulo } } : {}),
    };

    const [porModulo, porUsuario, porAccion, total] = await Promise.all([
      prisma.bitacora.groupBy({
        by: ['modulo'],
        where,
        _count: { _all: true },
        orderBy: { _count: { modulo: 'desc' } },
      }),
      prisma.bitacora.groupBy({
        by: ['usuarioNombre'],
        where,
        _count: { _all: true },
        orderBy: { _count: { usuarioNombre: 'desc' } },
      }),
      prisma.bitacora.groupBy({
        by: ['accion'],
        where,
        _count: { _all: true },
        orderBy: { _count: { accion: 'desc' } },
      }),
      prisma.bitacora.count({ where }),
    ]);

    const filasModulo: FilaReporte[] = porModulo.map((grupo) => ({
      modulo: grupo.modulo,
      acciones: grupo._count._all ?? 0,
    }));

    const filasUsuario: FilaReporte[] = porUsuario.map((grupo) => ({
      usuario: grupo.usuarioNombre ?? 'Sistema',
      acciones: grupo._count._all ?? 0,
    }));

    const filasAccion: FilaReporte[] = porAccion.map((grupo) => ({
      accion: grupo.accion,
      acciones: grupo._count._all ?? 0,
    }));

    return {
      titulo: 'Resumen de bitácora',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiEntero('Acciones registradas', total),
        kpiEntero('Módulos con actividad', filasModulo.length),
        kpiEntero('Usuarios activos', filasUsuario.length),
      ],
      secciones: [
        {
          titulo: 'Por módulo',
          columnas: COLUMNAS_MODULO,
          filas: filasModulo,
          totales: totalesDe(COLUMNAS_MODULO, filasModulo),
        },
        {
          titulo: 'Por usuario',
          columnas: COLUMNAS_USUARIO,
          filas: filasUsuario,
          totales: totalesDe(COLUMNAS_USUARIO, filasUsuario),
        },
        {
          titulo: 'Por tipo de acción',
          columnas: COLUMNAS_ACCION,
          filas: filasAccion,
          totales: totalesDe(COLUMNAS_ACCION, filasAccion),
        },
      ],
      orientacion: 'vertical',
      notas: [
        'El agrupado por usuario usa el nombre congelado en cada registro, no el actual: ' +
          'así una baja o un cambio de nombre no reescribe el historial.',
      ],
    };
  },
};
