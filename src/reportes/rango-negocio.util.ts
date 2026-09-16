import { BadRequestException } from '@nestjs/common';
import { getFechaUTC6 } from '../common/utils/date.util';
import { textoSeguroParaMensaje } from './formato.util';

/**
 * Rangos de fechas para reportes, en el día de negocio (UTC-6).
 *
 * **`getFechaUTC6()` no sirve para filtrar.** Esa función resta seis horas y existe
 * para *escribir*: cada `fechaCreacion` de la base pasó por ella, así que el valor
 * almacenado ya **es** la hora de pared de Guatemala, solo que sin declararlo.
 * Usarla otra vez al construir un rango restaría las seis horas por segunda vez y
 * correría la ventana: entrarían las últimas 6 h del mes anterior y se perderían las
 * últimas 6 h del mes pedido.
 *
 * Por eso los bordes se construyen con `Date.UTC` a partir de componentes. Y por eso
 * agrupar por día no necesita ningún `DATEADD` en el SQL: el desfase ya viene aplicado
 * en el dato.
 *
 * Si algún día se corrigiera el almacenamiento a UTC real, el cambio sería envolver la
 * expresión de agrupación en `DATEADD(hour, HORAS_UTC_NEGOCIO, fecha)` y sumar el
 * offset a estos bordes. Nada más.
 */

/** Desfase del negocio respecto a UTC. El mismo que aplica `getFechaUTC6()` al escribir. */
export const HORAS_UTC_NEGOCIO = -6;

const FORMATO_ISO = /^\d{4}-\d{2}-\d{2}$/;

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** Convierte 'YYYY-MM-DD' en el instante de pared 00:00:00 de ese día. */
export function inicioDelDiaNegocio(fechaIso: string): Date {
  if (!FORMATO_ISO.test(fechaIso ?? '')) {
    throw new BadRequestException(
      `La fecha '${textoSeguroParaMensaje(fechaIso, 20)}' no tiene el formato esperado (AAAA-MM-DD).`,
    );
  }

  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  // Date.UTC y no `new Date(anio, mes - 1, dia)`: el segundo depende de la zona
  // horaria del proceso Node, que es UTC en el servidor y UTC-6 en la máquina de
  // quien desarrolla. Los tests pasarían por accidente en un sitio y fallarían en el otro.
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));

  if (Number.isNaN(fecha.getTime()) || fecha.getUTCMonth() !== mes - 1) {
    throw new BadRequestException(
      `La fecha '${textoSeguroParaMensaje(fechaIso, 20)}' no existe en el calendario.`,
    );
  }

  return fecha;
}

/**
 * Borde superior **exclusivo**: las 00:00 del día siguiente.
 *
 * No es 23:59:59.999. `DateTime2` guarda fracciones más finas que el milisegundo, así
 * que un `lte` sobre ese valor pierde las ventas del último instante del día.
 */
export function finDelDiaNegocio(fechaIso: string): Date {
  return new Date(inicioDelDiaNegocio(fechaIso).getTime() + 86_400_000);
}

/** Hoy según el negocio, no según UTC. */
export function hoyNegocio(): string {
  return getFechaUTC6().toISOString().slice(0, 10);
}

/** Primer día del mes en curso, en formato ISO. */
export function inicioDelMesNegocio(): string {
  return `${hoyNegocio().slice(0, 7)}-01`;
}

/** Etiqueta legible para el encabezado del reporte. */
export function describirPeriodo(desdeIso: string, hastaIso: string): string {
  const [aDesde, mDesde, dDesde] = desdeIso.split('-').map(Number);
  const [aHasta, mHasta, dHasta] = hastaIso.split('-').map(Number);

  if (desdeIso === hastaIso) {
    return `${dDesde} de ${MESES[mDesde - 1]} de ${aDesde}`;
  }
  if (aDesde === aHasta && mDesde === mHasta) {
    return `${dDesde} al ${dHasta} de ${MESES[mDesde - 1]} de ${aDesde}`;
  }
  if (aDesde === aHasta) {
    return `${dDesde} de ${MESES[mDesde - 1]} al ${dHasta} de ${MESES[mHasta - 1]} de ${aDesde}`;
  }
  return `${dDesde} de ${MESES[mDesde - 1]} de ${aDesde} al ${dHasta} de ${MESES[mHasta - 1]} de ${aHasta}`;
}

/** Tope de rango. Un reporte de diez años no se consulta: se cuelga y tumba el pool. */
export const MAXIMO_DIAS_RANGO = 366;

export interface RangoNegocio {
  desde: Date;
  /** Exclusivo. */
  hasta: Date;
  etiqueta: string;
}

/**
 * Construye el rango a partir de dos fechas ISO inclusivas para el usuario
 * ("del 1 al 31 de agosto" incluye el 31 completo).
 */
export function rangoNegocio(desdeIso: string, hastaIso: string): RangoNegocio {
  const desde = inicioDelDiaNegocio(desdeIso);
  const hasta = finDelDiaNegocio(hastaIso);

  if (hasta <= desde) {
    throw new BadRequestException(
      `El rango de fechas está invertido: '${textoSeguroParaMensaje(desdeIso, 20)}' es ` +
        `posterior a '${textoSeguroParaMensaje(hastaIso, 20)}'.`,
    );
  }

  const dias = Math.round((hasta.getTime() - desde.getTime()) / 86_400_000);
  if (dias > MAXIMO_DIAS_RANGO) {
    throw new BadRequestException(
      `El rango solicitado abarca ${dias} días y el máximo es ${MAXIMO_DIAS_RANGO}. ` +
        'Acote las fechas y vuelva a intentarlo.',
    );
  }

  return { desde, hasta, etiqueta: describirPeriodo(desdeIso, hastaIso) };
}
