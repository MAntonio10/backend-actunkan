/**
 * Retorna la fecha y hora actual ajustada a la zona horaria UTC-6.
 * Esta función se utiliza para registrar la fecha y hora en la base de datos
 * cuando el servidor se encuentra configurado en UTC (6 horas adelantadas respecto a UTC-6).
 *
 * @param fecha Opcional. Fecha a ajustar. Por defecto es Date.now() / new Date().
 * @returns Objeto Date con el offset de -6 horas aplicado.
 */
export function getFechaUTC6(fecha: Date = new Date()): Date {
  const OFFSET_HORAS = 6;
  return new Date(fecha.getTime() - OFFSET_HORAS * 60 * 60 * 1000);
}

export const obtenerFechaUTC6 = getFechaUTC6;
