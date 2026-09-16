import { DefinicionReporte, FilaReporte } from '../../contratos';
import {
  FILTRO_PERIODO,
  fechaHora,
  kpiEntero,
  periodoDe,
  recortar,
} from '../comunes';

const COLUMNAS = [
  {
    clave: 'nombre',
    titulo: 'Actividad',
    formato: 'texto' as const,
    ancho: 0.24,
  },
  { clave: 'sector', titulo: 'Sector', formato: 'texto' as const, ancho: 0.14 },
  { clave: 'autor', titulo: 'Publicó', formato: 'texto' as const, ancho: 0.14 },
  {
    clave: 'responsable',
    titulo: 'Responsable',
    formato: 'texto' as const,
    ancho: 0.14,
  },
  {
    clave: 'inicio',
    titulo: 'Inicio',
    formato: 'fechaHora' as const,
    anchoMinimo: 95,
  },
  {
    clave: 'fin',
    titulo: 'Fin',
    formato: 'fechaHora' as const,
    anchoMinimo: 95,
  },
  {
    clave: 'estado',
    titulo: 'Estado',
    formato: 'texto' as const,
    anchoMinimo: 70,
  },
];

/**
 * El estado se calcula contra la **hora real**, no contra `getFechaUTC6()`.
 *
 * Es la excepción deliberada del proyecto: `fechaInicio` y `fechaFin` llegan del cliente
 * como marcas de tiempo reales, y compararlas contra el reloj desplazado seis horas
 * dejaría marcada como "programada" una actividad que ya está corriendo. El criterio es
 * idéntico al de `ActividadesService.conVigencia`, para que el reporte y la pantalla
 * digan lo mismo.
 */
function estadoDe(
  inicio: Date,
  fin: Date | null,
  anulado: boolean,
  ahora: Date,
): string {
  if (anulado) return 'Anulada';
  if (fin && fin <= ahora) return 'Expirada';
  if (inicio > ahora) return 'Programada';
  return 'Vigente';
}

export const actividadesListado: DefinicionReporte = {
  clave: 'actividades-listado',
  titulo: 'Actividades del parque',
  descripcion:
    'Actividades del parque publicadas para el período, con su sector, quién la publicó, ' +
    'el responsable de ejecutarla, la ventana de fechas y si está programada, vigente, ' +
    'expirada o anulada. Sirve para planificar o revisar la agenda del parque.',
  categoria: 'Actividades',
  moduloOrigen: 'ActividadesParque',
  orientacionSugerida: 'horizontal',
  filtros: [
    FILTRO_PERIODO,
    {
      clave: 'sector',
      etiqueta: 'Sector',
      tipo: 'sector',
      descripcion: 'Sector del parque donde se realiza la actividad.',
    },
    {
      clave: 'incluirAnulados',
      etiqueta: 'Incluir anuladas',
      tipo: 'booleano',
      descripcion: 'Si se incluyen las actividades anuladas. Por omisión no.',
    },
  ],

  async ejecutar({ prisma, filtros, limiteFilas }) {
    const actividades = await prisma.actividadesParque.findMany({
      where: {
        ...(filtros.incluirAnulados ? {} : { anulado: false }),
        // Se cruza la ventana de la actividad con el período pedido: entra toda
        // publicación que estuvo activa en algún momento del rango, no solo las que
        // empezaron dentro de él.
        fechaInicio: { lt: filtros.hasta },
        OR: [{ fechaFin: null }, { fechaFin: { gte: filtros.desde } }],
        ...(filtros.idSectorParque
          ? { idSectorParque: filtros.idSectorParque }
          : {}),
      },
      orderBy: { fechaInicio: 'desc' },
      take: limiteFilas + 1,
      select: {
        nombreActividad: true,
        fechaInicio: true,
        fechaFin: true,
        anulado: true,
        sector: { select: { nombre: true } },
        autor: { select: { nombre: true } },
        responsable: { select: { nombre: true } },
      },
    });

    const ahora = new Date();
    const { filas: pagina, disponibles } = recortar(actividades, limiteFilas);

    const filas: FilaReporte[] = pagina.map((actividad) => ({
      nombre: actividad.nombreActividad,
      sector: actividad.sector?.nombre ?? null,
      autor: actividad.autor?.nombre ?? null,
      responsable: actividad.responsable?.nombre ?? null,
      inicio: fechaHora(actividad.fechaInicio),
      // Sin fecha de fin la publicación no expira nunca.
      fin: actividad.fechaFin
        ? fechaHora(actividad.fechaFin)
        : 'Sin vencimiento',
      estado: estadoDe(
        actividad.fechaInicio,
        actividad.fechaFin,
        actividad.anulado,
        ahora,
      ),
    }));

    const contar = (estado: string) =>
      filas.filter((fila) => fila.estado === estado).length;

    return {
      titulo: 'Actividades del parque',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiEntero('Actividades', filas.length),
        kpiEntero('Vigentes', contar('Vigente')),
        kpiEntero('Programadas', contar('Programada')),
        kpiEntero('Expiradas', contar('Expirada')),
      ],
      secciones: [{ columnas: COLUMNAS, filas, filasDisponibles: disponibles }],
      orientacion: 'horizontal',
      notas: [
        'Se incluye toda actividad cuya ventana de visibilidad se cruce con el período, ' +
          'aunque haya empezado antes.',
        'El estado se evalúa al momento de generar el reporte, no al final del período.',
      ],
    };
  },
};
