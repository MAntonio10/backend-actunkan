/**
 * Paginación compartida por todos los listados de la API.
 *
 * POR QUÉ UN ÚTIL Y NO EL BLOQUE COPIADO
 * --------------------------------------
 * El cálculo estaba repetido palabra por palabra en cuatro servicios (tickets,
 * donaciones, cierres de caja y actividades). Cada copia era una oportunidad de
 * que el tope del DTO y el del servicio se separaran: el mensaje de validación
 * decía "máximo 200" mientras el servicio no topaba nada, así que una llamada que
 * no pasara por el ValidationPipe podía traerse la tabla entera sin que nadie lo
 * notara.
 *
 * Aquí el tope vive en un solo objeto `OpcionesPaginacion` que alimenta las dos
 * capas: el DTO lo convierte en un `@Max` que responde 400 explicando el límite
 * (es lo que ve el frontend) y este útil lo recorta en silencio (es la red para
 * las llamadas internas y los tests, que no pasan por el pipe). Es imposible que
 * un 400 diga "máximo 100" y el servicio devuelva 200.
 */

/** Lo mínimo que este útil necesita de un DTO de consulta. */
export interface PaginacionQuery {
  pagina?: number;
  limite?: number;
}

export interface OpcionesPaginacion {
  limitePorDefecto: number;
  limiteMaximo: number;
}

export interface PaginacionResuelta {
  pagina: number;
  limite: number;
  skip: number;
  take: number;
}

/** El sobre que devuelven todos los listados paginados. */
export interface RespuestaPaginada<T> {
  datos: T[];
  total: number;
  pagina: number;
  limite: number;
}

/**
 * Tope general: 20 filas por página, nunca más de 200.
 *
 * Veinte es lo que entra en pantalla sin obligar a desplazarse: la página existe
 * para que el usuario encuentre lo que busca, no para que baje menos veces. El
 * máximo sigue en 200 porque es otra cosa —proteger al servidor— y porque los
 * selectores del formulario piden el catálogo entero de una sola vez.
 */
export const PAGINACION_POR_DEFECTO: OpcionesPaginacion = {
  limitePorDefecto: 20,
  limiteMaximo: 200,
};

/**
 * Actividades pagina más corto porque cada fila arrastra sus imágenes y su sector:
 * 200 publicaciones con adjuntos pesan mucho más que 200 folios de ticket.
 */
export const PAGINACION_ACTIVIDADES: OpcionesPaginacion = {
  limitePorDefecto: 20,
  limiteMaximo: 100,
};

/**
 * La bitácora reparte igual que el resto. Se conserva el preset con nombre propio
 * porque es la tabla que más crece y la candidata más probable a querer otra
 * medida de página; teniéndolo aquí, ese cambio es una línea y no toca el servicio.
 */
export const PAGINACION_BITACORA: OpcionesPaginacion = {
  limitePorDefecto: 20,
  limiteMaximo: 200,
};

/**
 * Traduce los parámetros de consulta al `skip`/`take` que espera Prisma.
 *
 * `Math.floor` porque Prisma rechaza un `take` decimal, y `Math.min` porque un
 * `limite` fuera de rango debe degradar al tope, no reventar la consulta. Una
 * `pagina` más allá del total devuelve una página vacía a propósito: mentir sobre
 * en qué página está el cliente desalinearía su paginador.
 */
export function resolverPaginacion(
  query?: PaginacionQuery,
  opciones: OpcionesPaginacion = PAGINACION_POR_DEFECTO,
): PaginacionResuelta {
  const pagina = query?.pagina && query.pagina > 0 ? Math.floor(query.pagina) : 1;
  const solicitado =
    query?.limite && query.limite > 0 ? Math.floor(query.limite) : opciones.limitePorDefecto;
  const limite = Math.min(solicitado, opciones.limiteMaximo);

  return { pagina, limite, skip: (pagina - 1) * limite, take: limite };
}

/**
 * Arma el sobre de respuesta.
 *
 * Recibe el objeto de `resolverPaginacion` entero, no `pagina` y `limite` sueltos:
 * ambos son `number` y el compilador no avisaría si se invirtieran al llamar.
 *
 * `total` sale siempre del `count` con el mismo `where` que el listado, nunca de
 * `datos.length`: `datos` es una página, no el conjunto filtrado.
 */
export function construirRespuestaPaginada<T>(
  datos: T[],
  total: number,
  paginacion: PaginacionResuelta,
): RespuestaPaginada<T> {
  return { datos, total, pagina: paginacion.pagina, limite: paginacion.limite };
}
