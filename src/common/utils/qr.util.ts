import { createHmac, timingSafeEqual } from 'crypto';

/**
 * El QR del pase codifica únicamente el folio del ticket y una firma HMAC.
 * Sin firma, cualquiera que conozca el formato del folio podría imprimir un pase
 * válido; con firma, falsificarlo exige el secreto del servidor.
 */
const SECRETO_POR_DEFECTO = 'aktunkan-ticket-qr-dev';

function obtenerSecreto(): string {
  return process.env.TICKET_QR_SECRET || SECRETO_POR_DEFECTO;
}

/**
 * Firma un folio de ticket. Devuelve el HMAC-SHA256 en hexadecimal.
 */
export function firmarNumeroTicket(numeroTicket: string): string {
  return createHmac('sha256', obtenerSecreto()).update(numeroTicket).digest('hex');
}

/**
 * Verifica la firma de un folio en tiempo constante, para no filtrar
 * información por diferencias de tiempo de comparación.
 */
export function verificarFirmaTicket(numeroTicket: string, firma?: string): boolean {
  if (!firma) return false;

  const esperada = Buffer.from(firmarNumeroTicket(numeroTicket), 'utf8');
  const recibida = Buffer.from(String(firma), 'utf8');

  if (esperada.length !== recibida.length) return false;

  return timingSafeEqual(esperada, recibida);
}

/**
 * Contenido que se codifica en el QR impreso. Los datos legibles del pase
 * (nombre, personas, total) los arma el frontend con la respuesta de la API:
 * aquí solo viaja lo necesario para validar en taquilla.
 */
export function construirPayloadQr(numeroTicket: string, firma: string): string {
  return JSON.stringify({ numeroTicket, firma });
}
