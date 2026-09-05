import { getFechaUTC6 } from '../common/utils/date.util';

/**
 * Resolución de tarifas **en un momento dado**, no solo la de hoy.
 *
 * La emisión online siempre quiere el precio de ahora, y para eso bastaba filtrar
 * por `vigenteHasta: null`. La venta offline no: una venta de ayer que se sube hoy
 * tiene que recalcularse con la tarifa que regía *ayer*, o el arqueo compara peras
 * con manzanas. Como `Tarifa` ya versiona por vigencia, el dato existe; lo que
 * faltaba era la consulta.
 *
 * ## Los bordes de la vigencia
 *
 * Al cambiar un precio, `TarifasService` cierra la fila anterior con
 * `vigenteHasta = t` y crea la nueva con `vigenteDesde = t`, **el mismo instante**.
 * Por eso la condición es `vigenteDesde <= fecha AND (vigenteHasta IS NULL OR
 * vigenteHasta > fecha)`: con `>` estricto, en el instante exacto `t` aplica solo
 * la nueva. Con `>=` aplicarían las dos y el precio elegido dependería del orden
 * de las filas.
 *
 * ## La conversión de reloj — el motivo de que esto reciba un instante real
 *
 * `vigenteDesde` y `vigenteHasta` se sellan con `getFechaUTC6()`, es decir
 * **desplazados 6 horas** respecto del tiempo real. Comparar contra ellos una marca
 * de tiempo real —como la `fechaEmision` que manda el dispositivo, en ISO con zona—
 * da resultados corridos 6 horas: durante ese lapso, una tarifa recién creada
 * parece no existir todavía.
 *
 * Para que no haya forma de equivocarse, estas funciones reciben **el instante real**
 * y hacen la conversión adentro. Quien llama pasa `new Date()` o
 * `new Date(dto.fechaEmision)` y no tiene que saber nada de husos.
 */

interface ClaveTarifa {
  idAtraccion: number;
  idOrigen: number;
  idTipoVisitante: number;
}

/** Condición de vigencia, en el espacio de fechas que usa la base. */
function ventanaVigente(fechaEnBase: Date) {
  return {
    vigenteDesde: { lte: fechaEnBase },
    OR: [{ vigenteHasta: null }, { vigenteHasta: { gt: fechaEnBase } }],
  };
}

/**
 * Tarifa que regía en `fecha` para esa combinación. `null` si no había ninguna
 * —por ejemplo una venta anterior a que se cargara el catálogo—; quien llama
 * decide si eso es un error.
 *
 * @param fecha Instante **real** (no desplazado). Por defecto, ahora.
 */
export async function resolverTarifaEn(
  tx: any,
  clave: ClaveTarifa,
  fecha: Date = new Date(),
): Promise<any | null> {
  const enBase = getFechaUTC6(fecha);

  return tx.tarifa.findFirst({
    where: {
      idAtraccion: clave.idAtraccion,
      idOrigen: clave.idOrigen,
      idTipoVisitante: clave.idTipoVisitante,
      anulado: false,
      ...ventanaVigente(enBase),
    },
    // Si por un error de datos hubiera ventanas superpuestas, gana la más
    // reciente que ya había empezado. Determinista, nunca al azar.
    orderBy: { vigenteDesde: 'desc' },
  });
}

/**
 * Tarifa del ticket de guía sin carnet que regía en `fecha`.
 * No depende de atracción ni de origen: es un precio único.
 *
 * @param fecha Instante **real** (no desplazado). Por defecto, ahora.
 */
export async function resolverTarifaGuiaEn(
  tx: any,
  fecha: Date = new Date(),
): Promise<any | null> {
  const enBase = getFechaUTC6(fecha);

  return tx.tarifaGuia.findFirst({
    where: ventanaVigente(enBase),
    orderBy: { vigenteDesde: 'desc' },
  });
}
