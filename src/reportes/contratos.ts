import { PrismaService } from '../prisma/prisma.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { ClaveAgrupacion } from './consultas/dimensiones';

/**
 * Contratos del motor de reportes.
 *
 * Dos estructuras sostienen todo el módulo: `DefinicionReporte` describe **qué se
 * puede pedir** y `EspecificacionReporte` **qué salió**. Los renderizadores (PDF y
 * Excel) solo conocen la segunda, así que ninguno sabe qué es un ticket ni una caja:
 * por eso agregar un formato de salida no toca ninguna definición, y agregar un
 * reporte no toca ningún renderizador.
 */

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export type FormatoColumna =
  | 'texto'
  | 'entero'
  | 'decimal'
  | 'moneda'
  | 'porcentaje'
  | 'fecha'
  | 'fechaHora';

export type AlineacionColumna = 'izquierda' | 'centro' | 'derecha';

export interface ColumnaReporte {
  clave: string;
  titulo: string;
  formato: FormatoColumna;
  /** Por defecto: derecha para los formatos numéricos, izquierda para el resto. */
  alineacion?: AlineacionColumna;
  /** Fracción del ancho útil (0-1). Sin valor, el renderizador la calcula. */
  ancho?: number;
  anchoMinimo?: number;
  decimales?: number;
  /** Cómo se agrega en la fila de totales. Ausente = la columna no lleva total. */
  total?: 'suma' | 'promedio' | 'conteo';
  /**
   * Columna de supervisión (monto esperado, diferencia de arqueo).
   *
   * `ReportesService` la elimina —columna y celdas— cuando el solicitante no tiene
   * `Cajas.Editar`. Se borra del dato y no del dibujo: ocultarla solo en el PDF
   * dejaría el valor viajando en el JSON del endpoint hermano.
   */
  soloSupervisor?: boolean;
}

/**
 * Lo único que puede haber en una celda.
 *
 * Deliberadamente **no** admite `Prisma.Decimal` ni `Date`: un Decimal serializado
 * con JSON.stringify sale como objeto, y un Date se reinterpreta según la zona del
 * proceso. La conversión ocurre en la capa de consulta y el compilador lo obliga.
 */
export type ValorCelda = string | number | boolean | null;
export type FilaReporte = Record<string, ValorCelda>;

export interface SeccionReporte {
  titulo?: string;
  descripcion?: string;
  columnas: ColumnaReporte[];
  filas: FilaReporte[];
  /** Calculados por la definición con Decimal, nunca por el renderizador. */
  totales?: FilaReporte | null;
  saltoDePaginaAntes?: boolean;
  /** Filas que existían antes de recortar, para la nota al pie. */
  filasDisponibles?: number;
}

export interface KpiReporte {
  etiqueta: string;
  /** Ya formateado: los renderizadores no formatean KPIs. */
  valor: string;
  detalle?: string;
  soloSupervisor?: boolean;
}

export interface EspecificacionReporte {
  titulo: string;
  subtitulo?: string;
  periodo?: { desde: string; hasta: string; etiqueta: string };
  /**
   * Se imprime siempre, incluso vacío: un reporte sin constancia de con qué filtros
   * se generó no sirve para auditar nada.
   */
  filtrosAplicados: Array<{ etiqueta: string; valor: string }>;
  kpis: KpiReporte[];
  secciones: SeccionReporte[];
  orientacion: 'vertical' | 'horizontal';
  notas?: string[];
}

export interface ResultadoReporte extends EspecificacionReporte {
  clave: string;
  /** ISO en hora de negocio (getFechaUTC6), coherente con lo que guarda la base. */
  generadoEn: string;
  generadoPor: string;
  truncado: boolean;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export type TipoFiltro =
  | 'rangoFechas'
  | 'usuario'
  | 'atraccion'
  | 'origen'
  | 'pais'
  | 'guia'
  | 'tipoVisitante'
  | 'tipoRecorrido'
  | 'opcionPago'
  | 'aperturaCaja'
  | 'sector'
  | 'modulo'
  | 'accion'
  | 'booleano'
  /** Lista cerrada: los valores admitidos viajan en `opciones`. */
  | 'opciones'
  | 'numero';

export interface EsquemaFiltro {
  clave: string;
  etiqueta: string;
  tipo: TipoFiltro;
  /** Se envía a la IA para que sepa qué puede pedir. */
  descripcion: string;
  requerido?: boolean;
  /**
   * Valores admitidos cuando el filtro es una lista cerrada (`tipo: 'opciones'`).
   *
   * Viajan en el catálogo y no escritos en el frontend a propósito: así una
   * dimensión nueva aparece en el formulario sin tocar la pantalla, igual que
   * un reporte nuevo aparece en el menú.
   */
  opciones?: Array<{ valor: string; etiqueta: string }>;
}

/** Filtros ya resueltos: IDs y `Date`, nunca texto libre del usuario. */
export interface FiltrosResueltos {
  desde: Date;
  hasta: Date;
  /** Etiqueta legible del período, ej. "1 al 31 de agosto de 2026". */
  etiquetaPeriodo: string;
  /** Fechas ISO originales, para reconstruir la URL de descarga de la vía 1. */
  desdeIso: string;
  hastaIso: string;
  /**
   * Los filtros en texto legible, ya con los nombres resueltos ("Vendedor: Juan Pérez").
   * Los arma el resolutor, que es quien tradujo los ids, y se imprimen en el encabezado
   * de los tres formatos: un reporte sin constancia de sus filtros no es auditable.
   */
  aplicados: Array<{ etiqueta: string; valor: string }>;
  idUsuario?: number;
  idAtraccion?: number;
  idOrigen?: number;
  idPais?: number;
  idGuia?: number;
  idTipoVisitante?: number;
  idTipoRecorrido?: number;
  idOpcionPago?: number;
  idAperturaCaja?: number;
  idSectorParque?: number;
  modulo?: string;
  accion?: string;
  incluirAnulados?: boolean;

  // --- Reporte a medida (ventas-a-medida) ---

  /** Agrupación (catálogo o corte de tiempo). Validada contra la lista blanca. */
  dimension?: ClaveAgrupacion;
  /** Segunda agrupación: convierte el desglose en una tabla cruzada. */
  dimension2?: ClaveAgrupacion;
  /** Qué se mide y por qué se ordena. */
  metrica?: 'total' | 'tickets' | 'personas';
  /** Cuántas filas se muestran (top N). */
  tope?: number;
  /** Día de la semana, 0=domingo. Solo lo expresan las consultas en SQL. */
  diaSemana?: number;
}

export type ModuloOrigen =
  | 'EmisionTickets'
  | 'Cajas'
  | 'Donaciones'
  | 'Bitacora'
  | 'Usuarios'
  | 'ActividadesParque';

export type CategoriaReporte =
  'Tickets' | 'Cajas' | 'Donaciones' | 'Bitácora' | 'Usuarios' | 'Actividades';

export interface ContextoReporte {
  prisma: PrismaService;
  filtros: FiltrosResueltos;
  ejecutor: EjecutorInfo;
  /** Tiene `Cajas.Editar`: habilita las columnas y KPIs de supervisión. */
  esSupervisor: boolean;
  /** Tope de filas a materializar; lo fija el servicio según el formato de salida. */
  limiteFilas: number;
}

export interface DefinicionReporte {
  /** Identificador estable, en kebab-case. Es lo que viaja en la URL. */
  clave: string;
  titulo: string;
  /** Se envía a la IA: de esta frase depende que acierte al elegir el reporte. */
  descripcion: string;
  categoria: CategoriaReporte;
  /**
   * Permiso del módulo **dueño de los datos**, no de 'Reportes'.
   *
   * Tener acceso al módulo de reportes no puede ser la puerta trasera a un módulo
   * que no se le concedió al usuario: sin esta comprobación, dar `Reportes.Ver` a un
   * cajero le entregaría de golpe la bitácora, la matriz de permisos y las donaciones.
   */
  moduloOrigen: ModuloOrigen;
  /** Exige además `Cajas.Editar` para siquiera ejecutarse. */
  soloSupervisor?: boolean;
  orientacionSugerida?: 'vertical' | 'horizontal';
  filtros: EsquemaFiltro[];
  ejecutar(ctx: ContextoReporte): Promise<EspecificacionReporte>;
}

/** Formatos de salida que entiende el controlador. */
export type FormatoSalida = 'json' | 'pdf' | 'excel';
