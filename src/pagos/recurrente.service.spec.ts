import { RecurrenteService, VIGENCIA_CHECKOUT_MS } from './recurrente.service';

/**
 * Lo que se prueba acá es el contrato de la fecha, no la red.
 *
 * `expires_at` es el único campo del proyecto que viaja a un tercero como instante
 * real. Todo lo demás se guarda con `getFechaUTC6()`, que devuelve el reloj de pared
 * de Guatemala —el epoch corrido seis horas—. Confundirlos no rompe nada visible:
 * simplemente los checkouts nacen vencidos. Este archivo existe para que una futura
 * "unificación de fechas" no reintroduzca ese desfase en silencio.
 */
describe('RecurrenteService.crearCheckout', () => {
  const SECRETO_PREVIO = process.env.RECURRENTE_SECRET_KEY;
  let servicio: RecurrenteService;
  let cuerpoEnviado: any;

  beforeEach(() => {
    process.env.RECURRENTE_SECRET_KEY = 'llave-de-prueba';
    servicio = new RecurrenteService();

    global.fetch = jest.fn(async (_url: any, opciones: any) => {
      cuerpoEnviado = JSON.parse(opciones.body);
      return {
        ok: true,
        status: 200,
        // El servicio lee el cuerpo con `text()` y parsea él mismo, para poder
        // recortar la respuesta en el log cuando no es JSON.
        text: async () =>
          JSON.stringify({
            id: 'ch_1',
            status: 'pending',
            checkout_url: 'https://pago/ch_1',
          }),
      };
    }) as any;
  });

  afterEach(() => {
    process.env.RECURRENTE_SECRET_KEY = SECRETO_PREVIO;
    jest.restoreAllMocks();
  });

  const crear = () =>
    servicio.crearCheckout({
      concepto: 'Ingreso Cuevas - Grupo',
      montoEnCentavos: 15000,
      successUrl: 'https://sitio/exito',
      cancelUrl: 'https://sitio/cancelado',
    });

  it('manda expires_at dos horas en el futuro', async () => {
    const antes = Date.now();
    await crear();

    const vence = new Date(cuerpoEnviado.expires_at).getTime();

    expect(vence).toBeGreaterThanOrEqual(antes + VIGENCIA_CHECKOUT_MS - 5000);
    expect(vence).toBeLessThanOrEqual(
      Date.now() + VIGENCIA_CHECKOUT_MS + 5000,
    );
  });

  /**
   * La aserción que importa: si alguien cambia `Date.now()` por `getFechaUTC6()`,
   * el vencimiento cae cuatro horas en el PASADO y este test lo detecta.
   */
  it('no envía la fecha desplazada a la zona del negocio', async () => {
    await crear();

    const vence = new Date(cuerpoEnviado.expires_at).getTime();
    const desfase = vence - Date.now();

    expect(desfase).toBeGreaterThan(0);
    // Seis horas de desplazamiento darían ~-4 h; se exige que esté cerca de +2 h.
    expect(Math.abs(desfase - VIGENCIA_CHECKOUT_MS)).toBeLessThan(10_000);
  });

  it('expires_at es ISO 8601 en UTC', async () => {
    await crear();

    expect(cuerpoEnviado.expires_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('no altera el resto del cuerpo del checkout', async () => {
    await crear();

    expect(cuerpoEnviado.items[0].amount_in_cents).toBe(15000);
    expect(cuerpoEnviado.items[0].currency).toBe('GTQ');
    expect(cuerpoEnviado.items[0].card_payments_enabled).toBe('true');
    expect(cuerpoEnviado.success_url).toBe('https://sitio/exito');
    expect(cuerpoEnviado.cancel_url).toBe('https://sitio/cancelado');
  });
});
