/**
 * Contrato del panel de gráficas.
 *
 * Es **otra forma de datos**, no un reporte más, y por eso vive aparte. Un
 * reporte responde una pregunta concreta y su salida es una tabla que además se
 * imprime; un panel responde «cómo va el parque» de un vistazo, y su salida son
 * series listas para dibujar. Meterlo en el catálogo habría obligado a las dos
 * cosas a compartir estructura, y ninguna de las dos habría quedado bien: las
 * tablas no traen el tipo de gráfica sugerido y las series no traen columnas.
 *
 * Dos decisiones que conviene entender antes de tocar esto:
 *
 * 1. **Los puntos llevan `valor` numérico y los totales llegan formateados.**
 *    En el resto del módulo el dinero viaja como cadena decimal porque hay que
 *    sumarlo sin perder centavos. Una gráfica no suma: convierte a píxeles, y
 *    ahí un número es lo correcto. Para que nadie tenga que sumar los puntos, la
 *    serie ya trae su `total` exacto, calculado con Decimal en el servidor.
 * 2. **Cada serie dice qué gráfica le sienta bien** (`tipoSugerido`). Es una
 *    sugerencia, no una orden: el frontend puede ofrecer cambiarla. Pero la
 *    decisión de si una distribución se lee mejor en dona o en barras depende de
 *    los datos, y aquí es donde se conocen.
 */

export type TipoGraficaSugerido = 'linea' | 'barra' | 'dona' | 'embudo';

/**
 * Cada cuánto se agrupan las series temporales.
 *
 * Un año en días son 365 puntos: ilegibles en una gráfica de 300 px de alto y
 * un payload que crece sin que nadie lo mire. El grano lo elige el servidor
 * según la duración del período, y quien consulta puede forzarlo.
 */
export type GranoTemporal = 'dia' | 'semana' | 'mes';

/** Cómo se escribe un valor de esta serie. Igual que en los reportes. */
export type FormatoValorDashboard = 'moneda' | 'entero' | 'decimal' | 'porcentaje';

export interface PuntoSerie {
  /** Lo que se lee en el eje. */
  etiqueta: string;
  /** Para dibujar. Ya redondeado: no se usa para cuadrar cuentas. */
  valor: number;
  /**
   * Clave cruda del punto (fecha ISO, id de catálogo). Sirve para ordenar y
   * para enlazar con el detalle sin volver a interpretar la etiqueta.
   */
  clave?: string;
}

export interface SerieDashboard {
  clave: string;
  titulo: string;
  descripcion?: string;
  tipoSugerido: TipoGraficaSugerido;
  formato: FormatoValorDashboard;
  /** Qué se está midiendo, para la leyenda: "Recaudado", "Tickets", "Personas". */
  unidad: string;
  puntos: PuntoSerie[];
  /** Suma exacta de la serie, ya formateada. Nunca la calcule sumando puntos. */
  total: string;
  /**
   * Reporte del catálogo que muestra lo mismo en tabla, con sus filtros ya
   * puestos. Es lo que permite saltar de una gráfica al detalle imprimible.
   */
  urlDetalle?: string;
}

export interface VariacionKpi {
  /** Fracción, igual que los porcentajes de los reportes: 0.18 es 18 %. */
  porcentaje: number;
  direccion: 'sube' | 'baja' | 'igual';
  /** "vs. 1 al 31 de julio de 2026". */
  etiqueta: string;
}

export interface KpiDashboard {
  clave: string;
  etiqueta: string;
  /** Ya formateado. Se pinta tal cual, como en los reportes. */
  valor: string;
  formato: FormatoValorDashboard;
  /**
   * Contra el período inmediatamente anterior de la misma duración. Falta
   * cuando el período anterior no tuvo movimiento: dividir entre cero daría un
   * crecimiento infinito, que no significa nada.
   */
  variacion?: VariacionKpi;
}

export interface Dashboard {
  periodo: { desde: string; hasta: string; etiqueta: string };
  /**
   * Grano de las series temporales. Se declara porque cambia lo que significa
   * un punto: sin esto, una gráfica de doce puntos podría ser doce días o doce
   * meses y solo se sabría leyendo las etiquetas.
   */
  grano: GranoTemporal;
  /** `true` si lo eligió el servidor por la duración del período. */
  granoAutomatico: boolean;
  /** Con qué se comparan los KPIs. */
  comparadoCon: { desde: string; hasta: string; etiqueta: string };
  kpis: KpiDashboard[];
  series: SerieDashboard[];
  /**
   * Paneles que no se armaron por falta de permiso sobre el módulo dueño de los
   * datos. Se declaran en vez de desaparecer en silencio: un panel que falta sin
   * explicación se lee como un error del sistema.
   */
  omitidos: Array<{ panel: string; motivo: string }>;
  generadoEn: string;
  generadoPor: string;
}
