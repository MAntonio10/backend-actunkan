import { webcrypto } from 'crypto';
import {
  construirPayloadQrDispositivo,
  verificarFirmaDispositivo,
  verificarFirmaTicket,
} from './qr.util';

/**
 * Se firma con WebCrypto y se verifica con el `crypto` de Node, que es exactamente
 * el cruce real: el navegador de la taquilla firma, el servidor comprueba. Hacerlo
 * con la misma librería de los dos lados probaría bastante menos.
 */
async function generarTaquilla() {
  const par = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  const spki = await webcrypto.subtle.exportKey('spki', par.publicKey);

  const firmar = async (texto: string) => {
    const firma = await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      par.privateKey,
      new TextEncoder().encode(texto),
    );
    return Buffer.from(firma).toString('base64');
  };

  return { llavePublica: Buffer.from(spki).toString('base64'), firmar };
}

describe('firma de pases emitidos por la taquilla', () => {
  const FOLIO = 'TCK-D03-2026-000123';

  it('acepta una firma hecha por el dispositivo con su llave', async () => {
    const taquilla = await generarTaquilla();

    expect(
      verificarFirmaDispositivo(
        FOLIO,
        await taquilla.firmar(FOLIO),
        taquilla.llavePublica,
      ),
    ).toBe(true);
  });

  // Es el ataque evidente: reutilizar una firma buena para colar otro folio.
  it('rechaza la firma de un folio distinto', async () => {
    const taquilla = await generarTaquilla();
    const firmaDeOtro = await taquilla.firmar('TCK-D03-2026-000999');

    expect(
      verificarFirmaDispositivo(FOLIO, firmaDeOtro, taquilla.llavePublica),
    ).toBe(false);
  });

  it('rechaza una firma válida hecha por otra taquilla', async () => {
    const propia = await generarTaquilla();
    const ajena = await generarTaquilla();

    expect(
      verificarFirmaDispositivo(
        FOLIO,
        await ajena.firmar(FOLIO),
        propia.llavePublica,
      ),
    ).toBe(false);
  });

  it.each([undefined, '', 'no-es-base64-válido', 'AAAA'])(
    'devuelve false, sin lanzar, ante la firma %p',
    async (firma) => {
      const taquilla = await generarTaquilla();

      expect(() =>
        verificarFirmaDispositivo(FOLIO, firma as any, taquilla.llavePublica),
      ).not.toThrow();
      expect(
        verificarFirmaDispositivo(FOLIO, firma as any, taquilla.llavePublica),
      ).toBe(false);
    },
  );

  // Una llave corrupta en base de datos no puede tumbar el torniquete.
  it('una llave pública ilegible no lanza', async () => {
    const taquilla = await generarTaquilla();
    const firma = await taquilla.firmar(FOLIO);

    expect(() =>
      verificarFirmaDispositivo(FOLIO, firma, 'basura'),
    ).not.toThrow();
    expect(verificarFirmaDispositivo(FOLIO, firma, 'basura')).toBe(false);
  });

  // Los dos esquemas conviven: un pase de taquilla no debe colarse como del servidor.
  it('no se cruza con la firma HMAC del servidor', async () => {
    const taquilla = await generarTaquilla();

    expect(verificarFirmaTicket(FOLIO, await taquilla.firmar(FOLIO))).toBe(
      false,
    );
  });

  it('el QR lleva el dispositivo, para saber con qué llave verificar', async () => {
    const taquilla = await generarTaquilla();
    const firma = await taquilla.firmar(FOLIO);

    expect(
      JSON.parse(construirPayloadQrDispositivo(FOLIO, firma, 'disp-03')),
    ).toEqual({
      numeroTicket: FOLIO,
      firma,
      dispositivo: 'disp-03',
    });
  });

  /**
   * Una firma que llega con el `+` convertido en espacio no es un pase alterado:
   * es base64 que pasó por una URL o por un cuerpo `form-urlencoded`. Rechazarla
   * dejaba al portero mirando «el código QR no es válido o fue alterado» sobre un
   * pase legítimo, y solo en los emitidos sin conexión —la firma HMAC del servidor
   * es hexadecimal y no tiene ningún `+` que perder.
   *
   * Se repite hasta encontrar una firma que lleve `+`: sin ese carácter el caso no
   * se ejercita y la prueba pasaría sin probar nada.
   */
  it('tolera el `+` convertido en espacio al viajar por una URL', async () => {
    const taquilla = await generarTaquilla();

    let firma = await taquilla.firmar(FOLIO);
    for (let i = 0; i < 40 && !firma.includes('+'); i++) {
      firma = await taquilla.firmar(FOLIO);
    }
    expect(firma).toContain('+');

    expect(
      verificarFirmaDispositivo(
        FOLIO,
        firma.replace(/\+/g, ' '),
        taquilla.llavePublica,
      ),
    ).toBe(true);
  });

  it.each([
    ['base64url', (f: string) => f.replace(/\+/g, '-').replace(/\//g, '_')],
    ['sin relleno', (f: string) => f.replace(/=+$/, '')],
    ['con salto de línea', (f: string) => `${f.slice(0, 40)}
${f.slice(40)}`],
    ['con blancos alrededor', (f: string) => `  ${f}  `],
  ])('acepta la misma firma %s', async (_nombre, deformar) => {
    const taquilla = await generarTaquilla();
    const firma = await taquilla.firmar(FOLIO);

    expect(
      verificarFirmaDispositivo(FOLIO, deformar(firma), taquilla.llavePublica),
    ).toBe(true);
  });

  // La tolerancia no puede volverse una rendija: lo que no son 64 bytes no vale.
  it('una firma de otro tamaño sigue sin valer, aunque sea base64 legítimo', async () => {
    const taquilla = await generarTaquilla();
    const firma = await taquilla.firmar(FOLIO);

    expect(
      verificarFirmaDispositivo(FOLIO, firma.slice(0, 40), taquilla.llavePublica),
    ).toBe(false);
    expect(
      verificarFirmaDispositivo(
        FOLIO,
        Buffer.alloc(65).toString('base64'),
        taquilla.llavePublica,
      ),
    ).toBe(false);
  });
});
