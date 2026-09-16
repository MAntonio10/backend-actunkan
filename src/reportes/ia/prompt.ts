import { DefinicionReporte, EsquemaFiltro } from '../contratos';
import {
  CLAVES_AGRUPACION,
  DIAS_SEMANA_CLAVE,
  METRICAS,
} from '../consultas/dimensiones';
import { REGISTRO_REPORTES } from '../definiciones';
import { FILTROS_VENTAS, FILTRO_PERIODO } from '../definiciones/comunes';
import { hoyNegocio } from '../rango-negocio.util';

/**
 * Construcción del prompt y del esquema de respuesta.
 *
 * El catálogo que ve la IA **se genera del registro de definiciones**, no está escrito a
 * mano aquí. Ese es el detalle que evita que el sistema se pudra: al agregar un reporte
 * nuevo, la IA lo conoce sin que nadie recuerde venir a editar este archivo.
 *
 * Lo que sale del servidor hacia el proveedor: la frase que escribió el usuario, esta
 * descripción estructural y la fecha de hoy. Nada más. Ni un nombre de empleado, ni un
 * catálogo con datos, ni una cifra; los nombres propios los resuelve `ResolutorFiltros`
 * contra la base, ya de vuelta en el servidor.
 */

/**
 * El rango de fechas es **un** filtro para el frontend, que pinta un solo control, pero
 * **dos** campos en el esquema de respuesta (`desde` y `hasta`). Se traduce aquí para que
 * el catálogo que ve la IA use exactamente las mismas claves que el esquema: nombrarle un
 * campo `periodo` que luego no puede escribir es la forma más fácil de que devuelva algo
 * que no valida.
 */
function describirFiltro(filtro: DefinicionReporte['filtros'][number]): string {
  if (filtro.tipo === 'rangoFechas') {
    return (
      `      - desde: ${filtro.descripcion} Fecha inicial, AAAA-MM-DD.\n` +
      `      - hasta: Fecha final del mismo rango, AAAA-MM-DD.`
    );
  }
  return `      - ${filtro.clave}: ${filtro.descripcion}`;
}

/**
 * Bloques de filtros que se repiten en muchos reportes.
 *
 * Sin esto, el catálogo describía el rango de fechas dieciséis veces y los siete
 * filtros de venta nueve veces cada uno: **el 35 % del prompt eran líneas
 * idénticas**. En un proveedor con cupo de tokens por minuto eso no es un
 * detalle estético — con 4.659 tokens de prompt y un cupo de 8.000, apenas
 * cabía una petición por minuto y la segunda se llevaba un 429.
 *
 * Se describen una vez y cada reporte los cita por nombre. Lo que el modelo
 * necesita saber —qué filtros admite cada reporte— no cambia.
 */
const BLOQUES: Array<{ nombre: string; filtros: EsquemaFiltro[] }> = [
  { nombre: 'PERÍODO', filtros: [FILTRO_PERIODO] },
  // El periodo va aparte porque casi todos lo llevan, incluidos los que no son
  // de venta (bitácora, actividades).
  { nombre: 'VENTA', filtros: FILTROS_VENTAS.slice(1) },
];

function describirBloques(): string {
  return BLOQUES.map(
    (bloque) =>
      `  [${bloque.nombre}]\n${bloque.filtros.map(describirFiltro).join('\n')}`,
  ).join('\n');
}

function describirReporte(definicion: DefinicionReporte): string {
  const claves = new Set(definicion.filtros.map((filtro) => filtro.clave));

  // Un bloque se cita solo si el reporte acepta todos sus filtros; si acepta la
  // mitad, se describen sueltos y no se cita.
  const citados = BLOQUES.filter((bloque) =>
    bloque.filtros.every((filtro) => claves.has(filtro.clave)),
  );
  const cubiertas = new Set(
    citados.flatMap((bloque) => bloque.filtros.map((filtro) => filtro.clave)),
  );
  const propios = definicion.filtros.filter(
    (filtro) => !cubiertas.has(filtro.clave),
  );

  const referencias = citados.map((bloque) => `[${bloque.nombre}]`).join(' ');
  const sueltos = propios.map(describirFiltro).join('\n');

  const lineaFiltros = [
    referencias && `      Filtros: ${referencias}`,
    sueltos && `${referencias ? '      Además:\n' : '      Filtros que acepta:\n'}${sueltos}`,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    `  * ${definicion.clave}`,
    `      ${definicion.descripcion}`,
    lineaFiltros,
  ]
    .filter(Boolean)
    .join('\n');
}

export function describirCatalogo(): string {
  return [...REGISTRO_REPORTES.values()].map(describirReporte).join('\n');
}

/**
 * Esquema de la respuesta.
 *
 * Las claves de filtro son las mismas de `GenerarReporteDto`, que es el DTO que valida la
 * ruta manual. Si divergieran, una petición en lenguaje natural podría colar un filtro que
 * la ruta normal rechaza.
 */
export function esquemaRespuesta() {
  const texto = { type: 'string' };
  return {
    type: 'object',
    properties: {
      clave: {
        type: 'string',
        enum: [...REGISTRO_REPORTES.keys()],
        description: 'Clave del reporte que mejor responde a la petición.',
      },
      interpretacion: {
        type: 'string',
        description:
          'Una frase en español explicando qué reporte se va a generar y con qué filtros, ' +
          'para que el usuario confirme que se le entendió.',
      },
      formato: {
        type: 'string',
        enum: ['pdf', 'excel'],
        description:
          'Formato de salida. Siempre "pdf", salvo que la petición pida explícitamente ' +
          'Excel, hoja de cálculo, xlsx, o poder filtrar y sumar los datos.',
      },
      filtros: {
        type: 'object',
        properties: {
          desde: {
            type: 'string',
            description: 'Fecha inicial en formato AAAA-MM-DD.',
          },
          hasta: {
            type: 'string',
            description: 'Fecha final en formato AAAA-MM-DD.',
          },
          vendedor: texto,
          atraccion: texto,
          origen: texto,
          pais: texto,
          guia: texto,
          tipoVisitante: texto,
          tipoRecorrido: texto,
          formaPago: texto,
          caja: texto,
          sector: texto,
          modulo: texto,
          accion: texto,
          incluirAnulados: { type: 'string', enum: ['true', 'false'] },
          // Solo los usa 'ventas-a-medida'. Van con enum para que el modelo no
          // pueda inventarse una dimensión: el DTO la rechazaría igual, pero
          // así se ahorra el viaje y el segundo intento.
          dimension: { type: 'string', enum: [...CLAVES_AGRUPACION] },
          dimension2: { type: 'string', enum: [...CLAVES_AGRUPACION] },
          metrica: { type: 'string', enum: [...METRICAS] },
          // Filtra a un solo día de la semana; no confundir con la agrupación
          // 'diaSemana', que desglosa los siete.
          diaSemana: { type: 'string', enum: [...DIAS_SEMANA_CLAVE] },
          tope: {
            type: 'string',
            description: 'Cuántas filas mostrar, como número en texto ("5").',
          },
        },
        additionalProperties: false,
      },
    },
    required: ['clave', 'interpretacion', 'formato', 'filtros'],
    additionalProperties: false,
  };
}

/**
 * La fecha de hoy con su día de la semana.
 *
 * Sin el día, el modelo no puede resolver «el fin de semana pasado» ni «este
 * lunes»: calcular el día de la semana de una fecha es justo lo que un modelo de
 * lenguaje hace mal, y se notaba —«el fin de semana pasado» salía resuelto como
 * lunes y martes—. Dárselo cuesta seis palabras y lo convierte en un dato.
 *
 * `getUTCDay` y no `getDay`: la cadena ISO se interpreta como medianoche UTC, y
 * leerla en la zona del proceso (UTC-6) devolvería el día anterior.
 */
function hoyConDiaSemana(): string {
  const DIAS = [
    'domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado',
  ];
  const iso = hoyNegocio();
  return `${iso} (${DIAS[new Date(`${iso}T00:00:00Z`).getUTCDay()]})`;
}

export function promptDelSistema(): string {
  return `Eres el traductor de peticiones del módulo de reportes de Actún Kan, un parque
natural en Guatemala con venta de boletos en taquilla.

Tu única tarea es convertir la petición del usuario en un objeto JSON que indique qué
reporte del catálogo ejecutar y con qué filtros. **No consultas datos, no calculas cifras
y no inventas resultados**: el servidor ejecuta el reporte y produce los números.

Grupos de filtros que varios reportes comparten; cada reporte los cita por nombre:

${describirBloques()}

Catálogo de reportes disponibles:

${describirCatalogo()}

Reglas:

1. Elige exactamente una clave de las del catálogo. Si ninguna encaja, elige la más
   parecida y dilo en la interpretación.
2. Los valores de filtro van en texto tal como los dijo el usuario ("Juan", "cuevas",
   "extranjero"). El servidor los busca en la base de datos; tú no necesitas ids.
3. Las fechas van en formato AAAA-MM-DD. Hoy es ${hoyConDiaSemana()}. Resuelve las
   expresiones relativas contra esa fecha: "este mes" es del día 1 del mes en curso a hoy,
   "el mes pasado" es el mes calendario anterior completo, "esta semana" empieza el lunes,
   "ayer" es el día anterior en desde y hasta. "El fin de semana pasado" es el sábado y el
   domingo inmediatamente anteriores a hoy; "este fin de semana", el sábado y domingo de la
   semana en curso. Usa el día de la semana que te acabo de dar para contar hacia atrás.
4. Si el usuario no menciona fechas, omite desde y hasta: el servidor usará el mes en curso.
5. Pon solo los filtros que el usuario mencionó. No rellenes los demás.
5.1. Si ningún reporte específico responde la petición pero se trata de ventas,
   usa 'ventas-a-medida' con la agrupación que haga falta: es el que cubre los
   cortes que el catálogo no tiene (por guía, por recorrido), los cruces de dos
   ("por atracción y por país" -> dimension y dimension2) y los "top N"
   ("los 5 que más vendieron" -> tope: "5"). No lo uses cuando exista un reporte
   propio para ese corte.
5.1.1. Cuidado con los días de la semana: "qué guía trabajó más **los sábados**"
   pide filtrar (diaSemana: "sabado") y agrupar por guía; "ventas **por día de la
   semana**" pide desglosar (dimension: "diaSemana"). Filtrar deja solo ese día;
   agrupar muestra los siete. Si filtras por diaSemana, agrupa por otra cosa —lo
   que se esté preguntando, o dia/mes—: agrupar por el mismo día que acabas de
   filtrar devuelve una sola fila y no añade nada.
5.1.2. Las preguntas de patrón —por hora del día, por día de la semana— necesitan
   datos de sobra. Si no dicen período, usa el año en curso en vez del mes: un
   solo mes casi nunca tiene suficientes ventas para que el patrón signifique algo.
5.2. **Cuando pidan dos o más períodos por separado —"agosto y septiembre",
   "compara enero contra febrero", "mes a mes", "por semana", "por hora"— usa
   'ventas-a-medida' con dimension: mes (o semana, dia, diaSemana, horaDelDia) y
   un rango que cubra todo lo pedido.** Un solo desde/hasta no separa períodos:
   sin la agrupación, agosto y septiembre salen mezclados y no se responde la
   pregunta. Si además dicen "cantidad de tickets" o "cuántos tickets", agrega
   metrica: "tickets"; si dicen "cuántas personas" o "visitantes",
   metrica: "personas".
6. El formato es "pdf" salvo que pidan Excel, hoja de cálculo o xlsx de forma explícita.
7. La interpretación se le muestra al usuario, así que escríbela en español natural y en
   una sola frase, mencionando el período y los filtros que aplicaste. **No menciones la
   clave técnica del reporte ni digas "se generará el reporte X"**: di qué información
   trae, con palabras normales ("Detalle de los tickets anulados de agosto, en Excel").

Responde únicamente con el objeto JSON, sin texto alrededor y sin cercas de markdown.`;
}
