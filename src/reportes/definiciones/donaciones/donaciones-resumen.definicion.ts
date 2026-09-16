import { Prisma } from '@prisma/client';
import { DefinicionReporte, FilaReporte } from '../../contratos';
import { aDecimal, aEntero } from '../../formato.util';
import {
  FILTRO_PERIODO,
  FILTRO_VENDEDOR,
  kpiEntero,
  kpiMoneda,
  montoLegible,
  periodoDe,
  totalesDe,
} from '../comunes';

const COLUMNAS_DIA = [
  { clave: 'dia', titulo: 'Día', formato: 'fecha' as const, ancho: 0.25 },
  {
    clave: 'recibos',
    titulo: 'Recibos',
    formato: 'entero' as const,
    total: 'suma' as const,
  },
  {
    clave: 'monto',
    titulo: 'Monto',
    formato: 'moneda' as const,
    total: 'suma' as const,
  },
];

const COLUMNAS_USUARIO = [
  {
    clave: 'usuario',
    titulo: 'Recibió',
    formato: 'texto' as const,
    ancho: 0.4,
  },
  {
    clave: 'recibos',
    titulo: 'Recibos',
    formato: 'entero' as const,
    total: 'suma' as const,
  },
  {
    clave: 'monto',
    titulo: 'Monto',
    formato: 'moneda' as const,
    total: 'suma' as const,
  },
];

interface FilaDiaCruda {
  dia: string;
  recibos: number | bigint;
  monto: Prisma.Decimal | string | number | null;
}

/**
 * Cuánto se donó en el período y cómo se repartió.
 *
 * Las donaciones son efectivo que entra al mismo cajón que las ventas, así que este
 * reporte cuadra con la línea de donaciones del arqueo de cada turno.
 */
export const donacionesResumen: DefinicionReporte = {
  clave: 'donaciones-resumen',
  titulo: 'Resumen de donaciones',
  descripcion:
    'Cuánto se recaudó en donaciones durante el período, con el desglose por día y por ' +
    'el usuario que las recibió. Incluye los recibos anulados como cifra aparte.',
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

  async ejecutar({ prisma, filtros }) {
    const where = {
      anulado: false,
      fechaCreacion: { gte: filtros.desde, lt: filtros.hasta },
      ...(filtros.idUsuario ? { idUsuario: filtros.idUsuario } : {}),
    };

    const condiciones: Prisma.Sql[] = [
      Prisma.sql`d.anulado = 0`,
      Prisma.sql`d.fechaCreacion >= ${filtros.desde}`,
      Prisma.sql`d.fechaCreacion < ${filtros.hasta}`,
    ];
    if (filtros.idUsuario)
      condiciones.push(Prisma.sql`d.idUsuario = ${filtros.idUsuario}`);

    const [vigentes, anulados, porDiaCrudo, porUsuario] = await Promise.all([
      prisma.donacion.aggregate({
        where,
        _sum: { monto: true },
        _count: { _all: true },
      }),
      prisma.donacion.aggregate({
        where: { ...where, anulado: true },
        _sum: { monto: true },
        _count: { _all: true },
      }),
      // Truncar la fecha obliga a SQL crudo; `groupBy` de Prisma no sabe hacerlo.
      prisma.$queryRaw<FilaDiaCruda[]>`
        SELECT CONVERT(char(10), d.fechaCreacion, 23) AS dia,
               COUNT(*)                               AS recibos,
               ISNULL(SUM(d.monto), 0)                AS monto
        FROM [dbo].[Donacion] AS d
        WHERE ${Prisma.join(condiciones, ' AND ')}
        GROUP BY CONVERT(char(10), d.fechaCreacion, 23)
        ORDER BY dia ASC`,
      prisma.donacion.groupBy({
        by: ['idUsuario'],
        where,
        _sum: { monto: true },
        _count: { _all: true },
        orderBy: { _sum: { monto: 'desc' } },
      }),
    ]);

    const usuarios = await prisma.usuario.findMany({
      where: { id: { in: porUsuario.map((g) => g.idUsuario) } },
      select: { id: true, nombre: true },
    });
    const nombres = new Map(usuarios.map((u) => [u.id, u.nombre]));

    const filasDia: FilaReporte[] = porDiaCrudo.map((fila) => ({
      dia: fila.dia,
      recibos: aEntero(fila.recibos),
      monto: aDecimal(fila.monto).toFixed(4),
    }));

    const filasUsuario: FilaReporte[] = porUsuario.map((grupo) => ({
      usuario: nombres.get(grupo.idUsuario) ?? `#${grupo.idUsuario}`,
      recibos: grupo._count._all ?? 0,
      monto: aDecimal(grupo._sum.monto).toFixed(4),
    }));

    return {
      titulo: 'Resumen de donaciones',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiMoneda('Recaudado', aDecimal(vigentes._sum.monto)),
        kpiEntero('Recibos vigentes', vigentes._count._all ?? 0),
        kpiEntero(
          'Recibos anulados',
          anulados._count._all ?? 0,
          montoLegible(aDecimal(anulados._sum.monto)),
        ),
      ],
      secciones: [
        {
          titulo: 'Por día',
          columnas: COLUMNAS_DIA,
          filas: filasDia,
          totales: totalesDe(COLUMNAS_DIA, filasDia),
        },
        {
          titulo: 'Por usuario que recibió',
          columnas: COLUMNAS_USUARIO,
          filas: filasUsuario,
          totales: totalesDe(COLUMNAS_USUARIO, filasUsuario),
        },
      ],
      orientacion: 'vertical',
      notas: [
        'Las donaciones son siempre en efectivo y entran a la caja abierta, así que suman ' +
          'al arqueo del turno igual que una venta.',
        'Los recibos anulados no cuentan en el recaudado.',
      ],
    };
  },
};
