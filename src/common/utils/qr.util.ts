import { createHmac, createPublicKey, timingSafeEqual, verify } from 'crypto';

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
  return createHmac('sha256', obtenerSecreto())
    .update(numeroTicket)
    .digest('hex');
}

/**
 * Verifica la firma de un folio en tiempo constante, para no filtrar
 * información por diferencias de tiempo de comparación.
 */
export function verificarFirmaTicket(
  numeroTicket: string,
  firma?: string,
): boolean {
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
export function construirPayloadQr(
  numeroTicket: string,
  firma: string,
): string {
  return JSON.stringify({ numeroTicket, firma });
}

/**
 * Decodifica una firma base64 tolerando lo que el transporte le hace por el camino.
 *
 * La firma de la taquilla es base64 estándar, así que lleva `+` y `/`. Si en algún
 * tramo viaja por una URL o por un cuerpo `form-urlencoded`, el `+` se decodifica
 * como espacio: `Buffer.from(x, 'base64')` descarta ese carácter en vez de fallar,
 * los bytes salen corridos y la verificación dice que la firma no corresponde. El
 * síntoma es engañoso —«el código QR no es válido o fue alterado» sobre un pase
 * legítimo— y solo le ocurre a los emitidos sin conexión: la firma del servidor es
 * HMAC en hexadecimal, y ahí no hay ningún `+` que perder.
 *
 * Se acepta también base64url (`-` y `_`) y la falta de relleno, que es como la
 * devuelven varias librerías del navegador.
 */
export function normalizarFirmaBase64(firma: string): Buffer {
  const limpia = String(firma)
    // Los bordes se recortan antes de tocar los espacios: un pegado con blancos
    // alrededor es lo corriente, y convertirlos a `+` alargaría la firma.
    .trim()
    // Un espacio interior es el `+` que perdió una URL; los demás blancos sobran.
    .replace(/ /g, '+')
    .replace(/\s/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const faltante = limpia.length % 4;
  const relleno = faltante === 0 ? '' : '='.repeat(4 - faltante);

  return Buffer.from(limpia + relleno, 'base64');
}

/**
 * Verifica un pase firmado por la propia taquilla, no por el servidor.
 *
 * POR QUÉ EXISTE ESTE SEGUNDO ESQUEMA
 * -----------------------------------
 * `firmarNumeroTicket` necesita el secreto del servidor, así que un dispositivo sin
 * red no puede producir un QR válido. De ahí salían los folios pre-firmados: había
 * que repartirlos con conexión para gastarlos sin ella. Con una llave por taquilla
 * el dispositivo firma sus propios pases y aquí se comprueban con la pública, sin
 * reservar nada por adelantado.
 *
 * `dsaEncoding: 'ieee-p1363'` NO es opcional. WebCrypto —que es quien firma, en el
 * navegador— devuelve la firma ECDSA como r||s crudo de 64 bytes, mientras que Node
 * espera DER por defecto. Sin esta línea toda firma legítima se rechaza, y el
 * síntoma es desconcertante: la criptografía es correcta y aun así nada valida.
 *
 * Nunca lanza: una llave corrupta o una firma con formato inválido son un pase que
 * no vale, no un error del servidor. Un 500 en el torniquete sería peor que un «no».
 */
export function verificarFirmaDispositivo(
  numeroTicket: string,
  firmaBase64: string | undefined,
  llavePublicaSpkiBase64: string,
): boolean {
  if (!firmaBase64) return false;

  const firma = normalizarFirmaBase64(firmaBase64);

  // Una firma ECDSA P-256 en r||s son 64 bytes exactos. Comprobarlo antes de
  // verificar distingue «firma que no corresponde» de «firma que llegó rota por el
  // camino», que es el caso que antes se confundía con un pase falsificado.
  if (firma.length !== 64) return false;

  try {
    const llave = createPublicKey({
      key: Buffer.from(llavePublicaSpkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    return verify(
      'sha256',
      Buffer.from(numeroTicket, 'utf8'),
      { key: llave, dsaEncoding: 'ieee-p1363' },
      firma,
    );
  } catch {
    return false;
  }
}

/**
 * Contenido del QR de un pase emitido sin conexión.
 *
 * Lleva `dispositivo` porque el verificador necesita saber con qué llave pública
 * comprobar la firma; sin ese dato tendría que probarlas todas. El pase firmado por
 * el servidor sigue viajando sin ese campo, así que los lectores viejos y los pases
 * ya impresos siguen funcionando igual.
 */
export function construirPayloadQrDispositivo(
  numeroTicket: string,
  firma: string,
  idDispositivo: string,
): string {
  return JSON.stringify({ numeroTicket, firma, dispositivo: idDispositivo });
}

/**
 * QR de un ticket ya guardado, en el esquema que le corresponde.
 *
 * Un pase emitido sin conexión lo firmó la taquilla, así que su QR tiene que decir
 * cuál: es lo que permite al verificador ir directo a la llave pública correcta.
 * El pase firmado por el servidor sigue saliendo sin ese campo, para que los
 * lectores viejos y los ya impresos no cambien de comportamiento.
 */
export function construirQrDeTicket(ticket: {
  numeroTicket: string;
  qrFirma: string;
  dispositivoTaquilla?: { idDispositivo: string } | null;
}): string {
  const idDispositivo = ticket.dispositivoTaquilla?.idDispositivo;

  return idDispositivo
    ? construirPayloadQrDispositivo(
        ticket.numeroTicket,
        ticket.qrFirma,
        idDispositivo,
      )
    : construirPayloadQr(ticket.numeroTicket, ticket.qrFirma);
}
