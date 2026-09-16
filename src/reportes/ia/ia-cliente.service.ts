import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

export interface MensajeIA {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Estados en los que repetir la misma petición tiene sentido. */
const ESTADOS_TRANSITORIOS = new Set([500, 502, 503, 504]);
/** Tiempo límite de un intento. */
const TIEMPO_LIMITE_MS = 15_000;
/** Presupuesto de todos los intentos juntos: hay alguien esperando en pantalla. */
const TIEMPO_TOTAL_MS = 25_000;
const ESPERA_ENTRE_INTENTOS_MS = 600;
/** Espera máxima que se acepta de un 429 antes de darse por vencido. */
const MAX_ESPERA_LIMITE_MS = 12_000;

/**
 * Tope de tokens de la respuesta.
 *
 * La respuesta útil son unas pocas líneas de JSON, pero los modelos que razonan
 * gastan tokens invisibles antes de escribirla (unos 300-500 medidos). Sin este
 * tope el proveedor asume su valor por omisión —2048 en Groq— y en los niveles
 * gratuitos con límite de salida por minuto la petición se rechaza antes de
 * ejecutarse, por lo que *podría* llegar a escribir y no por lo que escribe.
 */
const MAX_TOKENS_RESPUESTA = 1200;

const esperar = (ms: number) => new Promise((listo) => setTimeout(listo, ms));

/**
 * Lo que se responde cuando el modelo no devuelve una especificación utilizable
 * y no es por estar caído.
 *
 * Pasa sobre todo cuando la petición no describe ningún reporte y el modelo se
 * niega: el proveedor devuelve 400 `json_validate_failed` con la negativa en
 * `failed_generation`. Eso no es una avería —anunciarla como tal manda a esperar
 * a que «vuelva» algo que nunca se cayó—, es una petición que hay que reformular.
 */
const MENSAJE_NO_INTERPRETABLE =
  'No se pudo interpretar la petición. Reformúlela indicando qué información ' +
  'necesita y de qué período, o elija un reporte del catálogo.';

/** Fallo del proveedor que sí mejora reintentando. Interno: nunca sale del servicio. */
class FalloTransitorioIA extends Error {
  constructor(
    mensaje: string,
    /** Lo que el proveedor pidió esperar, si lo dijo. */
    readonly esperaMs?: number,
  ) {
    super(mensaje);
  }
}

/** Lo que el modelo alcanzó a escribir antes de que el proveedor lo rechazara. */
function textoGenerado(cuerpo: string): string {
  try {
    return String(JSON.parse(cuerpo)?.error?.failed_generation ?? '');
  } catch {
    return '';
  }
}

/** Segundos de una cabecera tipo `7.815s` o `2m52.8s`. */
function segundosDeDuracion(valor: string | null): number | null {
  if (!valor) return null;
  const directo = Number(valor);
  if (Number.isFinite(directo)) return directo;

  const coincidencia = valor.match(/(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?/);
  if (!coincidencia) return null;
  const minutos = Number(coincidencia[1] ?? 0);
  const segundos = Number(coincidencia[2] ?? 0);
  const total = minutos * 60 + segundos;
  return total > 0 ? total : null;
}

/**
 * Cuánto pide esperar el proveedor ante un 429.
 *
 * Un 429 puede ser dos cosas muy distintas: un cupo por minuto que se repone
 * solo en segundos, o la cuota del día agotada. La diferencia está en las
 * cabeceras, y confundirlas cuesta caro en los dos sentidos: reintentar una
 * cuota agotada la quema del todo, y rendirse ante un cupo por minuto le niega
 * al usuario un reporte que habría salido esperando ocho segundos.
 */
function esperaSugerida(respuesta: Response): number | null {
  // Con `?.`: no todas las respuestas que llegan aquí son una Response real
  // —las pruebas la simulan— y quedarse sin la cabecera no puede tumbar la
  // traducción del error.
  const leer = (nombre: string) => respuesta.headers?.get(nombre) ?? null;
  const candidatos = [
    leer('retry-after'),
    leer('x-ratelimit-reset-tokens'),
    leer('x-ratelimit-reset-requests'),
  ]
    .map(segundosDeDuracion)
    .filter((valor): valor is number => valor !== null && valor > 0);

  return candidatos.length > 0 ? Math.min(...candidatos) : null;
}

/**
 * Cliente del proveedor de IA.
 *
 * Gemini, Groq, OpenRouter, Cerebras y Mistral exponen todos el mismo contrato
 * `POST /chat/completions` de OpenAI, así que un solo cliente los cubre a todos y cambiar
 * de proveedor es editar tres variables del `.env` sin tocar código.
 *
 * Sigue el mismo patrón que `RecurrenteService`: `fetch` nativo sin SDK, tiempo límite
 * explícito, errores traducidos a `ServiceUnavailableException` con mensaje en español, y
 * un `estaConfigurada` que permite que el resto del sistema siga operando sin la
 * integración. Aquí eso importa especialmente: **los 18 reportes predeterminados no pasan
 * por aquí en ningún momento**, así que si el proveedor cae o se agota la cuota, lo único
 * que deja de funcionar es la petición en lenguaje natural.
 */
@Injectable()
export class IaClienteService {
  private readonly logger = new Logger(IaClienteService.name);

  private get baseUrl(): string {
    return (
      process.env.IA_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/openai'
    ).replace(/\/$/, '');
  }

  private get modelo(): string {
    return process.env.IA_MODELO || 'gemini-3.8-flash';
  }

  /**
   * Modelo al que se cambia si el principal está saturado.
   *
   * La saturación es **por modelo**, no por cuenta: el proveedor responde
   * literalmente «This model is currently experiencing high demand», y en las
   * mismas condiciones otro modelo contesta a la primera. Por eso el último
   * intento cambia de modelo en vez de repetir el mismo una tercera vez.
   *
   * Sin configurar, todos los intentos usan el principal.
   */
  private get modeloRespaldo(): string {
    return process.env.IA_MODELO_RESPALDO || this.modelo;
  }

  private get apiKey(): string {
    const clave = process.env.IA_API_KEY;
    if (!clave) {
      throw new ServiceUnavailableException(
        'La interpretación con inteligencia artificial no está configurada (falta IA_API_KEY). ' +
          'Los reportes predeterminados siguen disponibles.',
      );
    }
    return clave;
  }

  /** ¿Está configurada la integración? Decide si el frontend pinta el campo de petición. */
  get estaConfigurada(): boolean {
    return Boolean(process.env.IA_API_KEY);
  }

  /**
   * Pide una respuesta en JSON según un esquema.
   *
   * Se manda `response_format` con `json_schema`, pero **no se confía en él**: el endpoint
   * compatible con OpenAI de Gemini no documenta el modo estricto y sigue en beta. Quien
   * llama valida la respuesta de todas formas.
   */
  async completarJson(mensajes: MensajeIA[], esquema: object): Promise<string> {
    const clave = this.apiKey;
    const inicio = Date.now();

    // Dos veces el principal y una el de respaldo. La saturación suele durar
    // segundos, así que el reintento inmediato sirve; si tampoco, se cambia de
    // modelo, que es lo que de verdad la esquiva.
    const modelos = [this.modelo, this.modelo, this.modeloRespaldo];

    for (const [indice, modelo] of modelos.entries()) {
      const esUltimo = indice === modelos.length - 1;

      try {
        return await this.intentar(modelo, mensajes, esquema, clave);
      } catch (error) {
        const transitorio = error instanceof FalloTransitorioIA;

        // Un 400, un 401 o la cuota agotada no mejoran repitiendo: se propagan.
        if (!transitorio) throw error;

        // Presupuesto total: alguien está esperando su reporte en pantalla, y
        // encadenar tres tiempos límite completos se siente como una caída.
        const agotado =
          Date.now() - inicio + (error.esperaMs ?? 0) > TIEMPO_TOTAL_MS;

        if (esUltimo || agotado) {
          this.logger.error(
            `El proveedor de IA no respondió tras ${indice + 1} intento(s): ${error.message}`,
          );

          // Agotar los intentos escribiendo JSON inválido no es una saturación:
          // el servicio contestó siempre, lo que no sirvió fue la respuesta.
          if (/JSON inválido/i.test(error.message)) {
            throw new UnprocessableEntityException(MENSAJE_NO_INTERPRETABLE);
          }

          throw new ServiceUnavailableException(
            'El servicio de inteligencia artificial está saturado en este momento. ' +
              'Vuelva a intentarlo en unos segundos o elija un reporte del catálogo, ' +
              'que no depende de él.',
          );
        }

        // Si el proveedor dijo cuánto esperar, se le hace caso: adivinar menos
        // solo consigue otro 429.
        const espera =
          error.esperaMs ?? ESPERA_ENTRE_INTENTOS_MS * (indice + 1);
        this.logger.warn(
          `Intento ${indice + 1} con '${modelo}' falló (${error.message}); ` +
            `reintentando en ${Math.round(espera)} ms…`,
        );
        await esperar(espera);
      }
    }

    // Inalcanzable: el bucle sale por return o por throw.
    throw new ServiceUnavailableException(
      'No se pudo obtener una respuesta del servicio de inteligencia artificial.',
    );
  }

  /**
   * Un intento contra el proveedor.
   *
   * Lanza `FalloTransitorioIA` cuando reintentar tiene sentido (red caída,
   * tiempo agotado, 5xx del proveedor) y `ServiceUnavailableException` cuando
   * no lo tiene: repetir un 400 da otro 400, y repetir un 429 gasta la poca
   * cuota que quedaba.
   */
  private async intentar(
    modelo: string,
    mensajes: MensajeIA[],
    esquema: object,
    clave: string,
  ): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;

    let respuesta: Response;
    try {
      respuesta = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clave}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelo,
          messages: mensajes,
          // Se está traduciendo una frase a filtros, no redactando: la creatividad aquí
          // solo produce interpretaciones distintas de la misma petición.
          temperature: 0,
          max_tokens: MAX_TOKENS_RESPUESTA,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'especificacion_reporte', schema: esquema },
          },
        }),
        // Nadie puede quedarse colgado esperando al proveedor mientras pide un reporte.
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
    } catch (error: any) {
      this.logger.error(
        `Fallo de red con el proveedor de IA (${url}, modelo ${modelo}): ${error.message}`,
      );
      throw new FalloTransitorioIA(`sin respuesta de red (${error.message})`);
    }

    const texto = await respuesta.text();

    if (!respuesta.ok) {
      this.logger.error(
        `El proveedor de IA respondió ${respuesta.status} con '${modelo}': ${texto.slice(0, 300)}`,
      );

      if (ESTADOS_TRANSITORIOS.has(respuesta.status)) {
        throw new FalloTransitorioIA(`el proveedor respondió ${respuesta.status}`);
      }

      // 400 `json_validate_failed`: el modelo no produjo el JSON del esquema.
      // Hay dos motivos muy distintos y solo uno mejora reintentando: si lo que
      // alcanzó a escribir trae una llave estaba intentándolo y le salió mal,
      // así que se reintenta; si es prosa, se negó, y repetir la misma petición
      // a temperatura 0 dará la misma negativa gastando cuota.
      if (respuesta.status === 400 && /json_validate_failed/i.test(texto)) {
        const intentoFallido = textoGenerado(texto);
        if (intentoFallido.includes('{')) {
          throw new FalloTransitorioIA('el modelo devolvió un JSON inválido');
        }
        this.logger.warn(
          `El modelo no quiso responder a la petición: ${intentoFallido.slice(0, 120)}`,
        );
        throw new UnprocessableEntityException(MENSAJE_NO_INTERPRETABLE);
      }

      if (respuesta.status === 429) {
        const espera = esperaSugerida(respuesta);

        // Cupo por minuto: se espera lo que pide y se reintenta. Es lo normal en
        // los niveles gratuitos, donde un prompt grande llena el cupo de tokens
        // por minuto con una sola petición.
        if (espera !== null && espera * 1000 <= MAX_ESPERA_LIMITE_MS) {
          throw new FalloTransitorioIA(
            `límite de uso; el proveedor pide esperar ${espera.toFixed(1)} s`,
            espera * 1000,
          );
        }

        // Sin cabecera o con una espera larga hay que decidir qué se le dice al
        // usuario, y los dos casos piden acciones distintas: esperar un minuto
        // o volver mañana. Se buscan señales explícitas de cuota agotada y
        // **no** la palabra 'billing': Groq la incluye en el enlace de mejora de
        // plan al pie de todos sus errores de cupo por minuto, así que buscarla
        // hacía anunciar una cuota agotada cada vez que se pedían dos reportes
        // seguidos.
        const esCuota = /quota|daily|per day|resource_exhausted/i.test(texto);
        throw new ServiceUnavailableException(
          esCuota
            ? 'Se agotó la cuota del servicio de inteligencia artificial. Vuelva a ' +
              'intentarlo más tarde o use un reporte del catálogo.'
            : 'El servicio de inteligencia artificial está recibiendo demasiadas ' +
              `peticiones${espera ? ` (pide esperar ${Math.round(espera)} s)` : ''}. ` +
              'Espere un momento o use un reporte del catálogo.',
        );
      }

      throw new ServiceUnavailableException(
        `El servicio de inteligencia artificial rechazó la solicitud (${respuesta.status}).`,
      );
    }

    let cuerpo: any;
    try {
      cuerpo = JSON.parse(texto);
    } catch {
      this.logger.error(
        `Respuesta no-JSON del proveedor de IA: ${texto.slice(0, 200)}`,
      );
      throw new ServiceUnavailableException(
        'El servicio de inteligencia artificial devolvió una respuesta inválida.',
      );
    }

    const contenido = cuerpo?.choices?.[0]?.message?.content;
    if (typeof contenido !== 'string' || contenido.trim() === '') {
      this.logger.error(
        `Respuesta sin contenido del proveedor de IA: ${texto.slice(0, 200)}`,
      );
      // Sin contenido y con corte por longitud es transitorio; se reintenta.
      throw new FalloTransitorioIA('el proveedor no devolvió contenido');
    }

    return contenido;
  }
}
