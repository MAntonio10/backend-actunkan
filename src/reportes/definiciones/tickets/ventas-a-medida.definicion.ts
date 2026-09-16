import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ColumnaReporte,
  DefinicionReporte,
  EsquemaFiltro,
  FilaReporte,
  KpiReporte,
  SeccionReporte,
} from '../../contratos';
import {
  CLAVES_AGRUPACION,
  ClaveAgrupacion,
  DIAS_SEMANA,
  DIAS_SEMANA_CLAVE,
  DIMENSIONES,
  DIMENSIONES_TIEMPO,
  ETIQUETA_METRICA,
  METRICAS,
  Metrica,
  esClaveTiempo,
  etiquetasDe,
} from '../../consultas/dimensiones';
import { separarMiles } from '../../formato.util';
import {
  FilaFlexible,
  agruparVentasFlexible,
} from '../../consultas/ventas.consulta';
import {
  COLUMNA_PARTICIPACION,
  COLUMNA_PERSONAS,
  COLUMNA_TICKETS,
  COLUMNA_TOTAL,
  FILTROS_VENTAS,
  FILTRO_PERIODO,
  NOTA_ANULADOS,
  NOTA_FECHA_VENTA,
  conParticipacion,
  kpiEntero,
  kpiMoneda,
  montoLegible,
  periodoDe,
  recortar,
  totalesDe,
} from '../comunes';

/**
 * Ventas agrupadas por lo que pida quien consulta.
 *
 * Es el reporte que **no tiene forma fija**: el resto del catálogo responde una
 * pregunta concreta, y este responde la que se le pase. Existe porque el
 * catálogo no puede anticipar todos los cortes útiles —por guía, por mes, por
 * hora del día, atracción cruzada con país— y crecerlo con una definición por
 * combinación daría decenas de entradas casi idénticas.
 *
 * Lo que lo hace seguro es que **la libertad está acotada por construcción**: la
 * agrupación no es SQL ni un nombre de columna, es una clave que solo sirve para
 * indexar dos listas blancas escritas en el código (`DIMENSIONES` y
 * `DIMENSIONES_TIEMPO`). Un valor que no esté ahí no encuentra entrada y se
 * rechaza antes de tocar la base. Las cifras las calcula la misma consulta de
 * ventas de siempre; lo único que cambia es por dónde agrupa.
 *
 * Los cortes de tiempo son los que responden «cuántos tickets en agosto y en
 * septiembre»: sin ellos el sistema solo sabía desglosar por día y devolvía los
 * dos meses mezclados, que es justo lo que no se preguntaba.
 *
 * Con dos agrupaciones la tabla se cruza: filas la primera, columnas la segunda.
 * Esas columnas se generan de los datos, así que sus claves salen numeradas
 * (`c0`, `c1`, …) y su título lleva el nombre del valor. El frontend lo pinta
 * sin saber nada de esto porque nunca tiene claves de columna escritas a mano.
 */

/** Tope de columnas de la tabla cruzada: más no se lee ni cabe en un PDF. */
const MAX_COLUMNAS = 10;

const OPCIONES_AGRUPACION = CLAVES_AGRUPACION.map((clave) => ({
  valor: clave,
  etiqueta: etiquetasDe(clave).columna,
}));

const FILTRO_DIMENSION: EsquemaFiltro = {
  clave: 'dimension',
  etiqueta: 'Agrupar por',
  tipo: 'opciones',
  descripcion:
    'Obligatorio. Por qué se agrupan las ventas. Catálogos: vendedor, atraccion, ' +
    'origen, pais, tipoRecorrido, guia. Cortes de tiempo: dia, semana, mes, ' +
    'diaSemana (lunes, martes…), horaDelDia. Es lo que distingue a este reporte: ' +
    'úsalo para desgloses que los demás no ofrecen, y usa mes cuando pidan ' +
    'comparar dos meses o ver la evolución mes a mes.',
  requerido: true,
  opciones: OPCIONES_AGRUPACION,
};

const FILTRO_DIMENSION_2: EsquemaFiltro = {
  clave: 'dimension2',
  etiqueta: 'Cruzar con',
  tipo: 'opciones',
  descripcion:
    'Opcional. Segunda agrupación, que convierte la tabla en un cruce: filas la ' +
    'primera y columnas la segunda ("por atracción y por mes"). Debe ser distinta ' +
    'de dimension.',
  opciones: OPCIONES_AGRUPACION,
};

const FILTRO_METRICA: EsquemaFiltro = {
  clave: 'metrica',
  etiqueta: 'Medir',
  tipo: 'opciones',
  descripcion:
    'Qué se mide y por qué se ordena de mayor a menor: total (dinero recaudado, ' +
    'es lo predeterminado), tickets (cantidad de tickets vendidos) o personas ' +
    '(visitantes que ingresaron).',
  opciones: METRICAS.map((metrica) => ({
    valor: metrica,
    etiqueta: ETIQUETA_METRICA[metrica],
  })),
};

const FILTRO_DIA_SEMANA: EsquemaFiltro = {
  clave: 'diaSemana',
  etiqueta: 'Solo los',
  tipo: 'opciones',
  descripcion:
    'Opcional. Deja únicamente las ventas de ese día de la semana. Es lo que ' +
    'responde a "qué guía trabajó más los sábados" o "cuánto se vende los lunes": ' +
    'agrupa por lo que se pregunte y filtra por el día. No lo confundas con ' +
    'dimension: diaSemana, que en vez de filtrar desglosa los siete días.',
  opciones: DIAS_SEMANA.map((dia, indice) => ({
    valor: DIAS_SEMANA_CLAVE[indice],
    etiqueta: `${dia[0].toLocaleUpperCase('es')}${dia.slice(1)}`,
  })),
};

const FILTRO_TOPE: EsquemaFiltro = {
  clave: 'tope',
  etiqueta: 'Mostrar solo',
  tipo: 'numero',
  descripcion:
    'Opcional. Cuántas filas mostrar, ya ordenadas de mayor a menor. Es lo que ' +
    'responde a "los 5 que más vendieron" o "top 10".',
};

/** Valor de una fila según la métrica pedida. */
function valorDe(fila: FilaFlexible, metrica: Metrica): Prisma.Decimal {
  return new Prisma.Decimal(metrica === 'total' ? fila.total : fila[metrica]);
}

/**
 * Cómo se ordena un desglose.
 *
 * Un corte de tiempo se lee en orden cronológico: una tabla de meses ordenada
 * por recaudación es ilegible. La excepción es el top N, donde lo que se pidió
 * es precisamente el ranking ("las 3 horas de más venta").
 */
function ordenCronologico(clave: ClaveAgrupacion, tope?: number): boolean {
  return esClaveTiempo(clave) && !tope;
}

/** Columna de la agrupación, con el formato que le corresponde. */
function columnaGrupo(clave: ClaveAgrupacion, ancho: number): ColumnaReporte {
  const tiempo = esClaveTiempo(clave) ? DIMENSIONES_TIEMPO[clave] : null;
  return {
    clave: 'grupo',
    titulo: etiquetasDe(clave).columna,
    formato: tiempo?.formato ?? 'texto',
    ancho,
  };
}

/**
 * Reparte las filas entre lo que se muestra y lo que se deja constar.
 *
 * La diferencia importa: `filasDisponibles` es la señal con la que el servicio
 * marca el reporte como **truncado** y le pone encima la nota de «acote el
 * rango». Un top N no es un truncamiento —es exactamente lo que se pidió—, así
 * que ahí no se rellena ese campo y el aviso lo pone esta definición con sus
 * propias palabras. Sin esta distinción, pedir «los 5 que más vendieron»
 * respondía con una advertencia de que faltaban datos.
 */
function repartir<T>(
  ordenadas: T[],
  tope: number | undefined,
  limiteFilas: number,
  descripcion: string,
): { filas: T[]; filasDisponibles?: number; nota?: string } {
  if (tope && tope < ordenadas.length) {
    return {
      filas: ordenadas.slice(0, tope),
      nota:
        `Se muestran ${tope} de ${ordenadas.length} ${descripcion}, las de mayor valor. ` +
        'Los indicadores y la fila de totales cuentan solo esas; el total del período ' +
        'completo va indicado debajo de cada indicador.',
    };
  }

  const { filas, disponibles } = recortar(ordenadas, limiteFilas);
  return { filas, filasDisponibles: disponibles };
}

/** Suma de un conjunto de filas agrupadas. */
function sumar(filas: FilaFlexible[]) {
  return filas.reduce(
    (acumulado, fila) => ({
      tickets: acumulado.tickets + fila.tickets,
      personas: acumulado.personas + fila.personas,
      recaudado: acumulado.recaudado.plus(new Prisma.Decimal(fila.total)),
    }),
    { tickets: 0, personas: 0, recaudado: new Prisma.Decimal(0) },
  );
}

/**
 * Indicadores del reporte, sumados de **las filas que la tabla muestra**.
 *
 * Es la regla que no hay que romper: la tarjeta de arriba y la fila de totales
 * tienen que decir lo mismo. Antes los indicadores sumaban todas las
 * agrupaciones y la tabla solo las del top N, así que «los 5 que más vendieron»
 * mostraba el recaudado de los quince encima de una tabla de cinco.
 *
 * Lo que se deja fuera no se pierde: cuando hay filas ocultas, cada indicador
 * lleva debajo el total del período completo. Y siguen sin salir de una consulta
 * aparte —la agregada de Prisma no sabe expresar el filtro por día de la
 * semana—, así que un reporte de sábados no puede mostrar el total de la semana.
 */
function kpisDe(visibles: FilaFlexible[], todas: FilaFlexible[]): KpiReporte[] {
  const mostrado = sumar(visibles);
  const completo = sumar(todas);
  const hayOcultas = visibles.length < todas.length;
  const contexto = (texto: string) => (hayOcultas ? texto : undefined);

  return [
    kpiMoneda(
      'Recaudado',
      mostrado.recaudado,
      contexto(`de ${montoLegible(completo.recaudado)} en el período`),
    ),
    kpiEntero(
      'Tickets emitidos',
      mostrado.tickets,
      contexto(`de ${separarMiles(String(completo.tickets))} en el período`),
    ),
    kpiEntero(
      'Personas',
      mostrado.personas,
      contexto(`de ${separarMiles(String(completo.personas))} en el período`),
    ),
    kpiMoneda(
      'Ticket promedio',
      mostrado.tickets > 0
        ? mostrado.recaudado.div(mostrado.tickets)
        : new Prisma.Decimal(0),
    ),
  ];
}

/** Desglose simple: una fila por valor de la agrupación. */
function seccionSimple(
  crudas: FilaFlexible[],
  clave: ClaveAgrupacion,
  metrica: Metrica,
  tope: number | undefined,
  limiteFilas: number,
): { seccion: SeccionReporte; nota?: string; visibles: FilaFlexible[] } {
  const columnas: ColumnaReporte[] = [
    columnaGrupo(clave, 0.32),
    COLUMNA_TICKETS,
    COLUMNA_PERSONAS,
    COLUMNA_TOTAL,
    COLUMNA_PARTICIPACION,
  ];

  const ordenadas = [...crudas].sort((a, b) =>
    ordenCronologico(clave, tope)
      ? a.orden1.localeCompare(b.orden1)
      : valorDe(b, metrica).comparedTo(valorDe(a, metrica)),
  );

  // La participación se calcula sobre todas las filas y **antes** de recortar:
  // si se hiciera después, un top 5 mostraría porcentajes que suman 100 y daría
  // a entender que no hay nada más.
  const filas = conParticipacion(
    ordenadas.map((fila) => ({
      grupo: fila.grupo1,
      tickets: fila.tickets,
      personas: fila.personas,
      total: fila.total,
    })),
  );

  const reparto = repartir(filas, tope, limiteFilas, etiquetasDe(clave).plural);

  return {
    seccion: {
      titulo: `Ventas por ${etiquetasDe(clave).columna.toLowerCase()}`,
      columnas,
      filas: reparto.filas,
      totales: totalesDe(columnas, reparto.filas),
      filasDisponibles: reparto.filasDisponibles,
    },
    nota: reparto.nota,
    // Las filas salen de `ordenadas` en el mismo orden, así que lo mostrado es
    // su prefijo: de ahí salen los indicadores.
    visibles: ordenadas.slice(0, reparto.filas.length),
  };
}

/** Tabla cruzada: filas la primera agrupación, columnas la segunda. */
function seccionCruzada(
  crudas: FilaFlexible[],
  clave: ClaveAgrupacion,
  clave2: ClaveAgrupacion,
  metrica: Metrica,
  tope: number | undefined,
  limiteFilas: number,
): {
  seccion: SeccionReporte;
  columnasOcultas: number;
  nota?: string;
  visibles: FilaFlexible[];
} {
  // Peso de cada valor de la segunda agrupación, para quedarse con los que
  // importan: una tabla de 40 columnas no la lee nadie y no cabe en un PDF.
  const peso = new Map<string, Prisma.Decimal>();
  const ordenDeColumna = new Map<string, string>();
  for (const fila of crudas) {
    const nombre = fila.grupo2 ?? '';
    peso.set(
      nombre,
      (peso.get(nombre) ?? new Prisma.Decimal(0)).plus(valorDe(fila, metrica)),
    );
    ordenDeColumna.set(nombre, fila.orden2 ?? '');
  }

  // Las columnas de tiempo van en orden cronológico; las de catálogo, por peso.
  const columnasVisibles = [...peso.entries()]
    .sort((a, b) =>
      esClaveTiempo(clave2)
        ? (ordenDeColumna.get(a[0]) ?? '').localeCompare(ordenDeColumna.get(b[0]) ?? '')
        : b[1].comparedTo(a[1]),
    )
    .slice(0, MAX_COLUMNAS)
    .map(([nombre]) => nombre);
  const columnasOcultas = peso.size - columnasVisibles.length;

  const esDinero = metrica === 'total';
  const formatoCelda = (esDinero ? 'moneda' : 'entero') as ColumnaReporte['formato'];

  const columnas: ColumnaReporte[] = [
    columnaGrupo(clave, 0.24),
    ...columnasVisibles.map((nombre, indice) => ({
      // Clave generada, no el nombre: un valor puede traer espacios, acentos o
      // llamarse igual que otra columna del reporte.
      clave: `c${indice}`,
      titulo: nombre,
      formato: formatoCelda,
      total: 'suma' as const,
    })),
    ...(columnasOcultas > 0
      ? [
          {
            clave: 'otros',
            titulo: `Otros (${columnasOcultas})`,
            formato: formatoCelda,
            total: 'suma' as const,
          },
        ]
      : []),
    { clave: 'totalFila', titulo: 'Total', formato: formatoCelda, total: 'suma' },
  ];

  const indicePorNombre = new Map(
    columnasVisibles.map((nombre, indice) => [nombre, `c${indice}`]),
  );

  const porGrupo = new Map<string, FilaReporte & { orden: string }>();
  for (const fila of crudas) {
    const actual =
      porGrupo.get(fila.grupo1) ??
      ({ grupo: fila.grupo1, orden: fila.orden1, totalFila: '0' } as FilaReporte & {
        orden: string;
      });

    const columna = indicePorNombre.get(fila.grupo2 ?? '') ?? 'otros';
    const acumular = (destino: string) => {
      const suma = new Prisma.Decimal(String(actual[destino] ?? 0)).plus(
        valorDe(fila, metrica),
      );
      actual[destino] = esDinero ? suma.toFixed(4) : suma.toFixed(0);
    };
    acumular(columna);
    acumular('totalFila');

    porGrupo.set(fila.grupo1, actual);
  }

  const ordenadas = [...porGrupo.values()].sort((a, b) =>
    ordenCronologico(clave, tope)
      ? a.orden.localeCompare(b.orden)
      : Number(b.totalFila ?? 0) - Number(a.totalFila ?? 0),
  );

  const reparto = repartir(ordenadas, tope, limiteFilas, etiquetasDe(clave).plural);
  // `orden` era solo para ordenar: no es una columna y no debe viajar.
  const filas = reparto.filas.map(({ orden: _orden, ...fila }) => fila);

  // Qué agrupaciones quedaron en la tabla: las columnas ocultas no pierden
  // datos —se suman en «Otros»—, pero las filas recortadas por el top N sí.
  const mostradas = new Set(filas.map((fila) => String(fila.grupo)));

  return {
    seccion: {
      titulo: `${etiquetasDe(clave).columna} por ${etiquetasDe(
        clave2,
      ).columna.toLowerCase()}`,
      descripcion: `Cada celda es ${ETIQUETA_METRICA[metrica].toLowerCase()}.`,
      columnas,
      filas,
      totales: totalesDe(columnas, filas),
      filasDisponibles: reparto.filasDisponibles,
    },
    columnasOcultas,
    nota: reparto.nota,
    visibles: crudas.filter((fila) => mostradas.has(fila.grupo1)),
  };
}

export const ventasAMedida: DefinicionReporte = {
  clave: 'ventas-a-medida',
  titulo: 'Ventas a medida',
  descripcion:
    'Desglose de ventas por la agrupación que se pida, en vez de una fija. Elígelo ' +
    'cuando la petición pida un corte que ningún otro reporte del catálogo ofrece: ' +
    'por guía, por tipo de recorrido, por mes, por semana, por día de la semana o ' +
    'por hora del día, un cruce de dos agrupaciones ("por atracción y por país") o ' +
    'un top N ("los 5 vendedores que más recaudaron"). Es también el único que puede ' +
    'comparar dos meses entre sí: agrupando por mes con un rango que los cubra. Para ' +
    'los cortes que ya tienen reporte propio —vendedor, atracción, origen, forma de ' +
    'pago, tipo de visitante— prefiere ese, que trae secciones y notas específicas.',
  categoria: 'Tickets',
  moduloOrigen: 'EmisionTickets',
  orientacionSugerida: 'vertical',
  filtros: [
    FILTRO_PERIODO,
    FILTRO_DIMENSION,
    FILTRO_DIMENSION_2,
    FILTRO_METRICA,
    FILTRO_DIA_SEMANA,
    FILTRO_TOPE,
    // El resto de filtros de venta: se puede agrupar por una cosa y recortar por otra.
    ...FILTROS_VENTAS.slice(1),
  ],

  async ejecutar({ prisma, filtros, limiteFilas }) {
    const dimension = filtros.dimension;

    if (!dimension) {
      throw new BadRequestException(
        'El reporte a medida necesita saber por qué agrupar. Indique "dimension" ' +
          `con uno de estos valores: ${CLAVES_AGRUPACION.join(', ')}.`,
      );
    }

    if (filtros.dimension2 === dimension) {
      throw new BadRequestException(
        'Las dos agrupaciones son la misma. Elija agrupaciones distintas o quite la segunda.',
      );
    }

    const metrica = filtros.metrica ?? 'total';
    const tope = filtros.tope ? Math.min(filtros.tope, limiteFilas) : undefined;

    const crudas = await agruparVentasFlexible(
      prisma,
      dimension,
      filtros.dimension2,
      filtros,
    );

    const notas = [NOTA_FECHA_VENTA, NOTA_ANULADOS];

    /*
     * La fila de clave nula es una categoría más, no un hueco: «Sin guía» son
     * los grupos que entraron por su cuenta. Se dice, porque en una pregunta
     * como «qué guía trabajó más» esa fila puede quedar primera y leerse como
     * si el sistema no supiera el nombre.
     */
    const dimensionDeCatalogo = !esClaveTiempo(dimension);
    if (dimensionDeCatalogo && crudas.some((fila) => fila.orden1 === '')) {
      notas.push(
        `«${DIMENSIONES[dimension].etiquetaNula}» no es un valor del catálogo: agrupa las ` +
          'ventas que no lo llevaban. Cuenta como una fila más y suma al total.',
      );
    }

    // Una tabla vacía no dice por qué está vacía, y con filtros estrechos —un
    // día de la semana dentro del mes en curso— es lo más probable que ocurra.
    // Decirlo evita que se lea como una falla del reporte.
    if (crudas.length === 0) {
      notas.unshift(
        `No hubo ventas que cumplan estos filtros en el período ${filtros.etiquetaPeriodo}. ` +
          'Pruebe con un rango de fechas más amplio o con menos filtros.',
      );
    }

    if (filtros.dimension2) {
      const { seccion, columnasOcultas, nota, visibles } = seccionCruzada(
        crudas,
        dimension,
        filtros.dimension2,
        metrica,
        tope,
        limiteFilas,
      );
      const kpis = kpisDe(visibles, crudas);

      if (columnasOcultas > 0) {
        notas.unshift(
          `La tabla muestra las ${MAX_COLUMNAS} columnas de mayor peso; las ${columnasOcultas} ` +
            'restantes se sumaron en «Otros».',
        );
      }
      if (nota) notas.unshift(nota);

      return {
        titulo: 'Ventas a medida',
        subtitulo: `${etiquetasDe(dimension).columna} cruzado con ${etiquetasDe(
          filtros.dimension2,
        ).columna.toLowerCase()}, midiendo ${ETIQUETA_METRICA[metrica].toLowerCase()}`,
        periodo: periodoDe(filtros),
        filtrosAplicados: filtros.aplicados,
        kpis,
        secciones: [seccion],
        // Una tabla cruzada es ancha por definición.
        orientacion: 'horizontal' as const,
        notas,
      };
    }

    const { seccion, nota, visibles } = seccionSimple(
      crudas,
      dimension,
      metrica,
      tope,
      limiteFilas,
    );
    const kpis = kpisDe(visibles, crudas);
    if (nota) notas.unshift(nota);

    return {
      titulo: 'Ventas a medida',
      subtitulo: `Agrupado por ${etiquetasDe(dimension).columna.toLowerCase()}, ordenado por ${
        ordenCronologico(dimension, tope)
          ? 'orden cronológico'
          : ETIQUETA_METRICA[metrica].toLowerCase()
      }`,
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis,
      secciones: [seccion],
      orientacion: 'vertical' as const,
      notas,
    };
  },
};
