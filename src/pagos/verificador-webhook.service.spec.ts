import { Test } from '@nestjs/testing';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  SECRETO_WEBHOOK_RECURRENTE,
  VerificadorWebhookService,
} from './verificador-webhook.service';

/**
 * Vector de prueba publicado por Svix, no uno generado con la propia librería.
 *
 * La diferencia importa: firmar y verificar con la misma librería pasaría incluso
 * con el secreto equivocado o el cuerpo mal tomado. Un vector de un tercero prueba
 * que el secreto, el cuerpo crudo y las cabeceras están bien cableados.
 */
const VECTOR = {
  id: 'msg_loFOjxBNrRLzqYUf',
  timestamp: '1731705121',
  cuerpo: '{"event_type":"ping","data":{"success":true}}',
  secreto: 'whsec_plJ3nmyCDGBKInavdOK15jsl',
  firma: 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
};

const cabeceras = (extra: Record<string, string> = {}) => ({
  'svix-id': VECTOR.id,
  'svix-timestamp': VECTOR.timestamp,
  'svix-signature': VECTOR.firma,
  ...extra,
});

async function crear(secreto: string) {
  const modulo = await Test.createTestingModule({
    providers: [
      VerificadorWebhookService,
      { provide: SECRETO_WEBHOOK_RECURRENTE, useValue: secreto },
    ],
  }).compile();

  return modulo.get(VerificadorWebhookService);
}

describe('VerificadorWebhookService', () => {
  // El vector es de noviembre de 2024 y la librería caduca las firmas a los cinco
  // minutos, así que sin fijar el reloj este archivo entero fallaría por caducidad.
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Number(VECTOR.timestamp) * 1000);
  });

  afterEach(() => jest.useRealTimers());

  it('acepta el vector publicado por Svix y devuelve el evento parseado', async () => {
    const verificador = await crear(VECTOR.secreto);

    const evento = verificador.verificar(
      Buffer.from(VECTOR.cuerpo),
      cabeceras(),
    );

    expect(evento).toEqual({ event_type: 'ping', data: { success: true } });
  });

  it('rechaza si se altera un solo byte del cuerpo', async () => {
    const verificador = await crear(VECTOR.secreto);
    const alterado = VECTOR.cuerpo.replace('true', 'fals');

    expect(() =>
      verificador.verificar(Buffer.from(alterado), cabeceras()),
    ).toThrow(UnauthorizedException);
  });

  /**
   * Es la prueba de que se verifica el cuerpo CRUDO y no un reserializado: el JSON
   * equivale al del vector campo por campo, pero los bytes son otros.
   */
  it('rechaza el mismo JSON con los campos reordenados', async () => {
    const verificador = await crear(VECTOR.secreto);
    const reordenado = JSON.stringify({
      data: { success: true },
      event_type: 'ping',
    });

    expect(() =>
      verificador.verificar(Buffer.from(reordenado), cabeceras()),
    ).toThrow(UnauthorizedException);
  });

  it('rechaza con otro secreto', async () => {
    const verificador = await crear('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');

    expect(() =>
      verificador.verificar(Buffer.from(VECTOR.cuerpo), cabeceras()),
    ).toThrow(UnauthorizedException);
  });

  it.each(['svix-id', 'svix-timestamp', 'svix-signature'])(
    'rechaza si falta la cabecera %s',
    async (omitida) => {
      const verificador = await crear(VECTOR.secreto);
      const sinUna: Record<string, string> = cabeceras();
      delete sinUna[omitida];

      expect(() =>
        verificador.verificar(Buffer.from(VECTOR.cuerpo), sinUna),
      ).toThrow(UnauthorizedException);
    },
  );

  it('rechaza una firma caducada', async () => {
    const verificador = await crear(VECTOR.secreto);
    // Seis minutos después: fuera de la ventana de cinco de la librería.
    jest.setSystemTime((Number(VECTOR.timestamp) + 6 * 60) * 1000);

    expect(() =>
      verificador.verificar(Buffer.from(VECTOR.cuerpo), cabeceras()),
    ).toThrow(UnauthorizedException);
  });

  describe('sin secreto configurado', () => {
    // 503 y no 401: la causa es que falta configurar el servidor, no que el
    // remitente sea sospechoso. Confundirlas manda a buscar el problema al lado
    // equivocado cuando alguien lea el log.
    it.each([
      ['vacío', ''],
      ['solo espacios', '   '],
      ['sin el prefijo whsec_', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'],
    ])('con un secreto %s responde 503, no 401', async (_caso, secreto) => {
      const verificador = await crear(secreto);

      expect(verificador.estaConfigurado).toBe(false);
      expect(() =>
        verificador.verificar(Buffer.from(VECTOR.cuerpo), cabeceras()),
      ).toThrow(ServiceUnavailableException);
    });
  });

  it('se reporta configurado cuando el secreto es usable', async () => {
    const verificador = await crear(VECTOR.secreto);

    expect(verificador.estaConfigurado).toBe(true);
  });
});
