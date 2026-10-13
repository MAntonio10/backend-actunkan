import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { VerificadorWebhookService } from './verificador-webhook.service';
import { WebhookRecurrenteService } from './webhook-recurrente.service';

const CUERPO = '{"event_type":"intent.succeeded"}';

/** Petición falsa con la forma que deja `rawBody: true` en el bootstrap. */
const peticion = (extra: Record<string, any> = {}) =>
  ({
    rawBody: Buffer.from(CUERPO),
    headers: {
      'svix-id': 'msg_1',
      'svix-timestamp': '1731705121',
      'svix-signature': 'v1,algo',
    },
    ...extra,
  }) as any;

async function crear(opciones: {
  verificar?: jest.Mock;
  procesar?: jest.Mock;
}) {
  const verificador = {
    verificar:
      opciones.verificar ??
      jest.fn().mockReturnValue({ event_type: 'intent.succeeded' }),
    estaConfigurado: true,
  };
  const webhooks = {
    procesar:
      opciones.procesar ?? jest.fn().mockResolvedValue({ resultado: 'APLICADO' }),
  };

  const modulo = await Test.createTestingModule({
    controllers: [WebhooksController],
    providers: [
      { provide: VerificadorWebhookService, useValue: verificador },
      { provide: WebhookRecurrenteService, useValue: webhooks },
    ],
  }).compile();

  return { controlador: modulo.get(WebhooksController), verificador, webhooks };
}

describe('WebhooksController', () => {
  it('verifica la firma antes de procesar y devuelve el resultado', async () => {
    const { controlador, verificador, webhooks } = await crear({});

    const res = await controlador.recurrente(peticion());

    expect(verificador.verificar).toHaveBeenCalled();
    expect(webhooks.procesar).toHaveBeenCalled();
    expect(res).toEqual({ recibido: true, resultado: 'APLICADO' });
  });

  /**
   * Lo que se verifica tiene que ser el buffer crudo, no un objeto reinterpretado:
   * la firma se calcula sobre esos bytes exactos.
   */
  it('le pasa al verificador el cuerpo crudo y las cabeceras tal cual', async () => {
    const { controlador, verificador } = await crear({});
    const req = peticion();

    await controlador.recurrente(req);

    const [cuerpo, cabeceras] = verificador.verificar.mock.calls[0];
    expect(Buffer.isBuffer(cuerpo)).toBe(true);
    expect(cuerpo.toString('utf8')).toBe(CUERPO);
    expect(cabeceras).toBe(req.headers);
  });

  it('procesa usando el svix-id como llave de deduplicación', async () => {
    const { controlador, webhooks } = await crear({});

    await controlador.recurrente(peticion());

    expect(webhooks.procesar.mock.calls[0][0]).toBe('msg_1');
    expect(webhooks.procesar.mock.calls[0][2]).toBe(CUERPO);
  });

  it('no procesa nada si la firma es inválida', async () => {
    const verificar = jest.fn(() => {
      throw new UnauthorizedException('Firma del webhook inválida.');
    });
    const { controlador, webhooks } = await crear({ verificar });

    await expect(controlador.recurrente(peticion())).rejects.toThrow(
      UnauthorizedException,
    );
    expect(webhooks.procesar).not.toHaveBeenCalled();
  });

  it('propaga el 503 cuando no hay secreto configurado', async () => {
    const verificar = jest.fn(() => {
      throw new ServiceUnavailableException();
    });
    const { controlador, webhooks } = await crear({ verificar });

    await expect(controlador.recurrente(peticion())).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(webhooks.procesar).not.toHaveBeenCalled();
  });

  it.each([
    ['sin rawBody', { rawBody: undefined }],
    ['con rawBody vacío', { rawBody: Buffer.alloc(0) }],
  ])('rechaza la petición %s antes de verificar', async (_caso, extra) => {
    const { controlador, verificador } = await crear({});

    await expect(controlador.recurrente(peticion(extra))).rejects.toThrow(
      BadRequestException,
    );
    expect(verificador.verificar).not.toHaveBeenCalled();
  });

  it('rechaza si falta el svix-id, que es la llave de deduplicación', async () => {
    const { controlador, webhooks } = await crear({});

    await expect(
      controlador.recurrente(
        peticion({ headers: { 'svix-signature': 'v1,algo' } }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(webhooks.procesar).not.toHaveBeenCalled();
  });
});
