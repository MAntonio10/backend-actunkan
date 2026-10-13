import { formatInTimeZone, getTimezoneOffset } from 'date-fns-tz';

/**
 * Zona horaria del negocio. Todo lo que el sistema guarda y reporta es hora de
 * Guatemala, sin importar dónde corra el servidor.
 */
export const ZONA_NEGOCIO = 'America/Guatemala';

/**
 * Hora del negocio, lista para guardar.
 *
 * QUÉ SE GUARDA Y POR QUÉ
 * -----------------------
 * La base almacena el **reloj de pared de Guatemala** en columnas `DateTime2`. O
 * sea: si en la taquilla son las 14:30, la fila dice 14:30. Es lo que hay en todo
 * el histórico —tickets, arqueos, bitácora— y lo que esperan los reportes y los
 * filtros por fecha.
 *
 * POR QUÉ NO SE RESTAN 6 HORAS A MANO
 * -----------------------------------
 * Antes el desplazamiento era la constante `6`. Eso funciona mientras Guatemala no
 * cambie de huso y nadie mueva el servidor, y son dos supuestos que no se sostienen
 * solos: el offset ahora lo da la base de datos de zonas horarias del sistema, así
 * que si el país adoptara horario de verano —lo tuvo en 2006— esto lo sigue sin que
 * nadie toque una línea.
 *
 * Lo que este ajuste **nunca** dependió es de la zona del servidor: `getTime()` es
 * epoch, igual en Tokio que en Madrid. El desfase por ubicación estaba en las
 * operaciones de CALENDARIO —`getFullYear`, `setHours`— que leen los campos locales
 * del proceso. Para eso están `anioDeNegocio` y `enHoraDeNegocio`.
 */
export function getFechaUTC6(fecha: Date = new Date()): Date {
  // `getTimezoneOffset` devuelve milisegundos y es negativo al oeste de Greenwich:
  // -21 600 000 para UTC-6. Sumarlo desplaza el instante al reloj de pared.
  return new Date(fecha.getTime() + getTimezoneOffset(ZONA_NEGOCIO, fecha));
}

export const obtenerFechaUTC6 = getFechaUTC6;

/**
 * Inversa de `getFechaUTC6`: de reloj de pared a instante real.
 *
 * Hace falta cada vez que una fecha **leída de la base** se compara con una que
 * nace de `new Date()` o llega de un dispositivo, porque esas son instantes reales
 * y las de la base son reloj de pared. Restarlas sin convertir da una diferencia de
 * seis horas que no existe.
 *
 * Es el borde donde se cruzan las dos convenciones, y hasta ahora se cruzaban sin
 * avisar: el acotado de una venta sin conexión comparaba el instante declarado por
 * la taquilla contra la apertura de caja tal como salía de la base, así que aceptaba
 * ventas fechadas hasta seis horas antes de que la caja existiera.
 */
export function aInstanteReal(fechaDePared: Date): Date {
  return new Date(
    fechaDePared.getTime() - getTimezoneOffset(ZONA_NEGOCIO, fechaDePared),
  );
}

/**
 * Año en curso **en Guatemala**, no en la zona del servidor.
 *
 * Es el que numera los folios (`TCK-2026-000001`). Leerlo con `getFullYear()` se
 * equivocaba durante las primeras horas de cada 1 de enero: a las 02:00 de Guatemala
 * ya es el año nuevo, pero un proceso en UTC-6 leyendo la fecha ya desplazada
 * respondía el año viejo, y el correlativo seguía la serie anterior.
 */
export function anioDeNegocio(fecha: Date = new Date()): number {
  return Number(formatInTimeZone(fecha, ZONA_NEGOCIO, 'yyyy'));
}

/** Fecha del negocio como `AAAA-MM-DD`, para comparar días sin arrastrar la hora. */
export function diaDeNegocio(fecha: Date = new Date()): string {
  return formatInTimeZone(fecha, ZONA_NEGOCIO, 'yyyy-MM-dd');
}

/**
 * Una hora concreta del reloj de Guatemala, en el mismo formato que guarda la base.
 *
 * `setHours(6, 0, 0, 0)` fijaba las 06:00 **del proceso**: con el servidor en UTC
 * eso era medianoche en Guatemala, y la jornada de la taquilla vencía seis horas
 * antes de lo previsto. Esta función parte del día de negocio, no del día local.
 *
 * @param diasDesplazados 0 es hoy en Guatemala; 1, mañana.
 */
export function enHoraDeNegocio(
  hora: number,
  diasDesplazados = 0,
  desde: Date = new Date(),
): Date {
  const [anio, mes, dia] = diaDeNegocio(desde).split('-').map(Number);

  // Se construye sobre UTC y se devuelve tal cual: la convención de la base es el
  // reloj de pared, así que estos campos SON los que se persisten.
  const base = Date.UTC(anio, mes - 1, dia + diasDesplazados, hora, 0, 0, 0);
  return new Date(base);
}
