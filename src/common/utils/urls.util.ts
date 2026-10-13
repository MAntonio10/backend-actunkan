/**
 * Las URL públicas del despliegue, en un solo lugar.
 *
 * POR QUÉ ESTO EXISTE
 * -------------------
 * Antes cada sitio que necesitaba una URL la armaba por su cuenta y caía a
 * `http://localhost:3000` si la variable faltaba. En desarrollo eso es cómodo; en
 * producción es una trampa silenciosa: los links de pago que se le mandan al
 * visitante apuntarían a su propia máquina, el pago se cobraría igual y el pase
 * nunca se confirmaría. Un fallo así no se nota hasta que un cliente reclama.
 *
 * Ahora todo sale de **dos** variables, y lo demás se deriva:
 *
 *   APP_URL   la dirección pública del frontend     (https://app.midominio.com)
 *   API_URL   la dirección pública de este backend  (https://api.midominio.com)
 *
 * `RECURRENTE_SUCCESS_URL` y `RECURRENTE_CANCEL_URL` siguen existiendo como
 * excepción para quien necesite rutas distintas, pero no hace falta tocarlas: por
 * omisión salen de `APP_URL`.
 */

/** Rutas del frontend a las que la pasarela devuelve al visitante. */
const RUTA_EXITO = '/pago/exito';
const RUTA_CANCELADO = '/pago/cancelado';

/** Ruta en la que este backend recibe los avisos de cobro. */
export const RUTA_WEBHOOK = '/webhooks/recurrente';

/** `true` solo cuando el proceso declara ser producción. */
export function esProduccion(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Quita la barra final para que al concatenar no salga `//`. */
function sinBarraFinal(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Dirección pública del frontend.
 *
 * Vacía en desarrollo cae a `http://localhost:3000`, que es donde corre `npm run
 * dev` del front. En producción no cae a nada: devuelve cadena vacía y quien la
 * necesite tiene que decidir si eso es un error, porque un valor por defecto
 * equivocado es peor que la ausencia.
 */
export function urlAplicacion(): string {
  const configurada = process.env.APP_URL;
  if (configurada && configurada.trim()) return sinBarraFinal(configurada);
  return esProduccion() ? '' : 'http://localhost:3000';
}

/** Dirección pública de este backend. Solo se usa para informar, no para operar. */
export function urlApi(): string {
  const configurada = process.env.API_URL;
  if (configurada && configurada.trim()) return sinBarraFinal(configurada);
  const puerto = process.env.PORT ?? 4000;
  return esProduccion() ? '' : `http://localhost:${puerto}`;
}

/** A dónde vuelve el visitante cuando la pasarela confirma el pago. */
export function urlExito(): string {
  return (
    process.env.RECURRENTE_SUCCESS_URL?.trim() ||
    `${urlAplicacion()}${RUTA_EXITO}`
  );
}

/** A dónde vuelve el visitante si cancela el pago. */
export function urlCancelado(): string {
  return (
    process.env.RECURRENTE_CANCEL_URL?.trim() ||
    `${urlAplicacion()}${RUTA_CANCELADO}`
  );
}

/** URL exacta que hay que registrar como webhook en la pasarela. */
export function urlWebhook(): string {
  const base = urlApi();
  return base ? `${base}${RUTA_WEBHOOK}` : RUTA_WEBHOOK;
}

/**
 * Orígenes que el navegador puede usar para llamar a esta API.
 *
 * El orden es deliberado: una lista explícita en `CORS_ORIGINS` manda sobre todo,
 * porque es la única forma de permitir varios dominios —el panel y la taquilla, por
 * ejemplo—. Si no hay lista, basta `APP_URL`, que es el caso normal de un solo
 * frontend. Y solo cuando no hay ninguna de las dos se abre a `*`, que es lo que
 * hace falta en desarrollo para que responda a `localhost` y a la IP de la red.
 *
 * Devuelve `null` cuando corresponde abrir a cualquier origen, para que quien llama
 * decida si eso es aceptable en su entorno.
 */
export function origenesCors(): string[] | null {
  const lista = process.env.CORS_ORIGINS?.split(',')
    .map((o) => sinBarraFinal(o))
    .filter(Boolean);

  if (lista?.length) return lista;

  // Se mira `APP_URL` cruda y no `urlAplicacion()`: en desarrollo esa función cae a
  // `http://localhost:3000`, y usarlo acá cerraría CORS a ese único origen. El
  // frontend de desarrollo se sirve también por la IP de la red para probar en el
  // teléfono de la taquilla, así que ahí hace falta seguir abierto.
  const app = process.env.APP_URL?.trim();
  if (app) return [sinBarraFinal(app)];

  return null;
}

/**
 * Qué está mal configurado para salir a producción.
 *
 * Se devuelve como lista en vez de lanzar: arrancar es lo correcto incluso con el
 * cobro con tarjeta a medio configurar —el parque tiene que poder vender en
 * efectivo—, pero nada de esto puede quedarse callado.
 */
export function problemasDeDespliegue(): string[] {
  const problemas: string[] = [];

  if (!urlAplicacion()) {
    problemas.push(
      'APP_URL no está definida: los links de pago que recibe el visitante no ' +
        'tendrían a dónde volver.',
    );
  }

  if (!urlApi()) {
    problemas.push(
      'API_URL no está definida: no se puede saber qué URL registrar como webhook ' +
        'en la pasarela.',
    );
  }

  if (!origenesCors()) {
    problemas.push(
      'Ni CORS_ORIGINS ni APP_URL están definidas: la API quedaría abierta a ' +
        'cualquier origen.',
    );
  }

  if (process.env.TRUST_PROXY !== 'true') {
    problemas.push(
      'TRUST_PROXY no está en true: detrás de un proxy inverso, el límite de ' +
        'peticiones contaría a todos los clientes como uno solo.',
    );
  }

  if (!process.env.RECURRENTE_WEBHOOK_SECRET?.trim()) {
    problemas.push(
      'RECURRENTE_WEBHOOK_SECRET está vacío: los cobros con tarjeta no se ' +
        'confirmarán y esos pases no abrirán la puerta.',
    );
  }

  const exito = urlExito();
  const cancelado = urlCancelado();
  const webhook = urlWebhook();

  for (const [nombre, url] of [
    ['de éxito', exito],
    ['de cancelación', cancelado],
    ['del webhook', webhook],
  ] as const) {
    if (url.startsWith('http://')) {
      problemas.push(
        `La URL ${nombre} usa http:// y no https://: la pasarela y el navegador ` +
          'necesitan TLS en producción.',
      );
    }
    if (/localhost|127\.0\.0\.1/.test(url)) {
      problemas.push(
        `La URL ${nombre} apunta a localhost (${url}): no sirve fuera del servidor.`,
      );
    }
  }

  return problemas;
}
