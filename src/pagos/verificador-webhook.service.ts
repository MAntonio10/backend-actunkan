import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Webhook } from 'svix';

/**
 * Token del secreto de firma. Se inyecta en vez de leer `process.env` adentro para
 * que las pruebas puedan pasar uno propio sin tocar el entorno del proceso.
 */
export const SECRETO_WEBHOOK_RECURRENTE = 'SECRETO_WEBHOOK_RECURRENTE';

/** Prefijo con el que la pasarela entrega el secreto de firma. */
const PREFIJO_SECRETO = 'whsec_';

/**
 * Verifica que un webhook venga de Recurrente y nadie lo haya tocado por el camino.
 *
 * POR QUÉ ESTO NO ES OPCIONAL
 * ---------------------------
 * El endpoint que recibe los webhooks es público: no hay sesión que presentar porque
 * quien llama es la pasarela, no una persona. La firma es lo ÚNICO que distingue un
 * aviso legítimo de cobro de una petición que cualquiera puede escribir. Sin
 * verificarla, `POST /webhooks/recurrente` sería un botón público para marcar
 * cualquier ticket como pagado y entrar al parque sin pagar.
 *
 * POR QUÉ LA LIBRERÍA Y NO HMAC A MANO
 * ------------------------------------
 * Recurrente entrega sus webhooks a través de Svix y recomienda su librería. Son
 * cuatro detalles fáciles de equivocar y que no avisan cuando se equivocan: el
 * secreto se usa como **bytes** decodificados del base64 que sigue a `whsec_`, no
 * como texto; el contenido firmado es `id.timestamp.cuerpo`; la cabecera puede
 * traer varias firmas separadas por espacio mientras se rota un secreto; y la
 * comparación tiene que ser en tiempo constante. La librería hace los cuatro.
 *
 * La tolerancia de tiempo también es suya: cinco minutos fijos, no configurables.
 * Es coherente por construcción, porque quien firma y quien verifica son el mismo
 * proveedor.
 *
 * POR QUÉ `svix` APARECE EN `transformIgnorePatterns` DE JEST
 * ----------------------------------------------------------
 * `svix@2.5.0` se publica **solo** como ESM: su `package.json` declara
 * `type: module` y un único `index.mjs`. Node 24 lo carga con `require()` sin
 * problema, pero Jest corre en CommonJS y lo rechaza con «Cannot use import
 * statement outside a module». De ahí las tres líneas del bloque `jest` del
 * `package.json`: sacarlo de los ignorados, transformar `.mjs` y añadir esa
 * extensión a `moduleFileExtensions`.
 *
 * No sirve sustituirlo por `standardwebhooks` —que es CommonJS y es quien hace el
 * trabajo por dentro— porque ese paquete solo acepta las cabeceras `webhook-*`, y
 * Recurrente manda `svix-*`. Comprobado: con `svix-*` responde «Missing required
 * headers».
 */
@Injectable()
export class VerificadorWebhookService {
  private readonly logger = new Logger(VerificadorWebhookService.name);
  private readonly webhook: Webhook | null;

  constructor(
    @Inject(SECRETO_WEBHOOK_RECURRENTE) private readonly secreto: string,
  ) {
    this.webhook = this.construir(secreto);
  }

  /** `true` si hay un secreto usable; lo consulta el arranque para avisar. */
  get estaConfigurado(): boolean {
    return this.webhook !== null;
  }

  /**
   * Devuelve el evento ya verificado y parseado.
   *
   * Recibe el cuerpo **crudo**: la firma se calcula sobre los bytes exactos que
   * llegaron, así que verificar sobre un JSON reserializado falla aunque el
   * contenido sea el mismo.
   *
   * @throws ServiceUnavailableException si no hay secreto configurado.
   * @throws UnauthorizedException si la firma no corresponde o está caducada.
   */
  verificar(
    cuerpoCrudo: Buffer,
    cabeceras: Record<string, string | string[] | undefined>,
  ): Record<string, any> {
    if (!this.webhook) {
      // Se distingue de la firma inválida a propósito: una es culpa nuestra (falta
      // configurar) y la otra del remitente. Confundirlas manda a buscar el problema
      // al lado equivocado.
      throw new ServiceUnavailableException(
        'La verificación de webhooks no está configurada en el servidor.',
      );
    }

    try {
      this.webhook.verify(cuerpoCrudo, cabeceras as Record<string, string>);
    } catch (error: any) {
      this.logger.warn(
        `Webhook rechazado por firma: ${error?.message ?? 'motivo no informado'}`,
      );
      throw new UnauthorizedException('Firma del webhook inválida.');
    }

    return JSON.parse(cuerpoCrudo.toString('utf8'));
  }

  /**
   * Un secreto ausente deja el webhook cerrado, no abierto.
   *
   * Se valida la forma además de la presencia: un valor mal pegado —sin el prefijo,
   * o recortado— produciría el mismo rechazo que una firma falsificada, y el log
   * diría que el remitente es sospechoso cuando el problema está en el `.env`.
   */
  private construir(secreto: string): Webhook | null {
    const limpio = (secreto ?? '').trim();

    if (!limpio) {
      this.logger.warn(
        'RECURRENTE_WEBHOOK_SECRET está vacío: POST /webhooks/recurrente responderá 503 ' +
          'y los pagos con tarjeta no se confirmarán. Péguelo antes de cobrar la primera.',
      );
      return null;
    }

    if (!limpio.startsWith(PREFIJO_SECRETO)) {
      this.logger.error(
        `RECURRENTE_WEBHOOK_SECRET no empieza con '${PREFIJO_SECRETO}': revise el valor copiado.`,
      );
      return null;
    }

    try {
      return new Webhook(limpio);
    } catch (error: any) {
      this.logger.error(
        `RECURRENTE_WEBHOOK_SECRET no es un secreto válido: ${error?.message}`,
      );
      return null;
    }
  }
}
