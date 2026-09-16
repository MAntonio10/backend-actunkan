import { DefinicionReporte, FilaReporte } from '../../contratos';
import { FILTRO_PERIODO, kpiEntero, periodoDe, totalesDe } from '../comunes';

const COLUMNAS_SECTOR = [
  { clave: 'sector', titulo: 'Sector', formato: 'texto' as const, ancho: 0.5 },
  {
    clave: 'actividades',
    titulo: 'Actividades',
    formato: 'entero' as const,
    total: 'suma' as const,
  },
];

const COLUMNAS_RESPONSABLE = [
  {
    clave: 'responsable',
    titulo: 'Responsable',
    formato: 'texto' as const,
    ancho: 0.5,
  },
  {
    clave: 'actividades',
    titulo: 'Actividades',
    formato: 'entero' as const,
    total: 'suma' as const,
  },
];

/**
 * Cómo se reparte la carga: qué sectores concentran actividad y sobre quién recae.
 */
export const actividadesPorSector: DefinicionReporte = {
  clave: 'actividades-por-sector',
  titulo: 'Actividades por sector',
  descripcion:
    'Cuántas actividades se publicaron en cada sector del parque durante el período, con ' +
    'un segundo desglose por responsable de ejecutarlas. Sirve para ver dónde se ' +
    'concentra el trabajo y cómo está repartido.',
  categoria: 'Actividades',
  moduloOrigen: 'ActividadesParque',
  orientacionSugerida: 'vertical',
  filtros: [FILTRO_PERIODO],

  async ejecutar({ prisma, filtros }) {
    const where = {
      anulado: false,
      fechaInicio: { lt: filtros.hasta },
      OR: [{ fechaFin: null }, { fechaFin: { gte: filtros.desde } }],
    };

    const [porSector, porResponsable, total] = await Promise.all([
      prisma.actividadesParque.groupBy({
        by: ['idSectorParque'],
        where,
        _count: { _all: true },
        orderBy: { _count: { idSectorParque: 'desc' } },
      }),
      prisma.actividadesParque.groupBy({
        by: ['idUsuarioResponsable'],
        where,
        _count: { _all: true },
        orderBy: { _count: { idUsuarioResponsable: 'desc' } },
      }),
      prisma.actividadesParque.count({ where }),
    ]);

    const [sectores, responsables] = await Promise.all([
      prisma.sectorParque.findMany({
        where: {
          id: {
            in: porSector
              .map((g) => g.idSectorParque)
              .filter((id): id is number => id !== null),
          },
        },
        select: { id: true, nombre: true },
      }),
      prisma.usuario.findMany({
        where: {
          id: {
            in: porResponsable
              .map((g) => g.idUsuarioResponsable)
              .filter((id): id is number => id !== null),
          },
        },
        select: { id: true, nombre: true },
      }),
    ]);

    const nombreSector = new Map(sectores.map((s) => [s.id, s.nombre]));
    const nombreResponsable = new Map(
      responsables.map((u) => [u.id, u.nombre]),
    );

    const filasSector: FilaReporte[] = porSector.map((grupo) => ({
      // El sector es opcional en la publicación, así que la fila sin sector es normal
      // y tiene que aparecer o el total no cuadraría.
      sector:
        grupo.idSectorParque === null
          ? 'Sin sector asignado'
          : (nombreSector.get(grupo.idSectorParque) ??
            `#${grupo.idSectorParque}`),
      actividades: grupo._count._all ?? 0,
    }));

    const filasResponsable: FilaReporte[] = porResponsable.map((grupo) => ({
      responsable:
        grupo.idUsuarioResponsable === null
          ? 'Sin responsable asignado'
          : (nombreResponsable.get(grupo.idUsuarioResponsable) ??
            `#${grupo.idUsuarioResponsable}`),
      actividades: grupo._count._all ?? 0,
    }));

    return {
      titulo: 'Actividades por sector',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiEntero('Actividades', total),
        kpiEntero('Sectores con actividad', filasSector.length),
        kpiEntero('Responsables', filasResponsable.length),
      ],
      secciones: [
        {
          titulo: 'Por sector',
          columnas: COLUMNAS_SECTOR,
          filas: filasSector,
          totales: totalesDe(COLUMNAS_SECTOR, filasSector),
        },
        {
          titulo: 'Por responsable',
          columnas: COLUMNAS_RESPONSABLE,
          filas: filasResponsable,
          totales: totalesDe(COLUMNAS_RESPONSABLE, filasResponsable),
        },
      ],
      orientacion: 'vertical',
      notas: [
        'Tanto el sector como el responsable son opcionales al publicar una actividad; ' +
          'las que no los llevan se agrupan aparte para que los totales cuadren.',
      ],
    };
  },
};
