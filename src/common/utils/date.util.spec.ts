import {
  ZONA_NEGOCIO,
  aInstanteReal,
  anioDeNegocio,
  diaDeNegocio,
  enHoraDeNegocio,
  getFechaUTC6,
} from './date.util';

/**
 * Lo que estas pruebas defienden es que **nada de esto dependa de dónde corra el
 * servidor**. Antes el desplazamiento era la constante 6 y las operaciones de
 * calendario leían el reloj del proceso, así que el mismo código daba respuestas
 * distintas en UTC que en UTC-6.
 *
 * `TZ` no se puede cambiar a mitad de un proceso de Node —el huso se cachea al
 * arrancar—, así que en vez de simularlo se comprueba lo que lo hace irrelevante:
 * que los resultados salgan de la zona `America/Guatemala` y no de campos locales.
 */
describe('hora de negocio', () => {
  it('la zona es explícita, no un desplazamiento adivinado', () => {
    expect(ZONA_NEGOCIO).toBe('America/Guatemala');
  });

  describe('getFechaUTC6: el reloj de pared que guarda la base', () => {
    // Guatemala no tiene horario de verano, así que hoy son 6 horas exactas. Lo que
    // cambia es de dónde sale el número: de la base de zonas, no de una constante.
    it('desplaza exactamente las horas del huso de Guatemala', () => {
      const instante = new Date('2026-06-15T18:00:00.000Z');

      expect(getFechaUTC6(instante).toISOString()).toBe(
        '2026-06-15T12:00:00.000Z',
      );
    });

    it('conserva el mismo desplazamiento en invierno y en verano', () => {
      const enero = new Date('2026-01-15T18:00:00.000Z');
      const julio = new Date('2026-07-15T18:00:00.000Z');

      const difEnero = enero.getTime() - getFechaUTC6(enero).getTime();
      const difJulio = julio.getTime() - getFechaUTC6(julio).getTime();

      expect(difEnero).toBe(difJulio);
      expect(difEnero).toBe(6 * 60 * 60 * 1000);
    });

    // El valor guardado es el mismo que producía la resta manual: cambiar de
    // implementación no puede reinterpretar los 209 tickets ya almacenados.
    it('produce el mismo valor que la resta de 6 horas que sustituye', () => {
      const instante = new Date('2026-09-28T23:31:00.000Z');
      const comoAntes = new Date(instante.getTime() - 6 * 60 * 60 * 1000);

      expect(getFechaUTC6(instante).getTime()).toBe(comoAntes.getTime());
    });
  });

  /**
   * El borde donde se cruzan las dos convenciones, y donde ya hubo un bug.
   *
   * Una fecha leída de la base es reloj de pared; una que llega de un dispositivo es
   * instante real. El acotado de las ventas sin conexión comparaba una contra otra
   * sin convertir, así que el piso quedaba seis horas antes de lo previsto y aceptaba
   * ventas fechadas antes de que la caja existiera — justo lo que ese piso evitaba,
   * porque la tarifa se resuelve a la fecha declarada.
   */
  describe('aInstanteReal: de la base al instante', () => {
    it('es la inversa exacta de getFechaUTC6', () => {
      const instante = new Date('2026-09-29T14:00:00.000Z');

      expect(aInstanteReal(getFechaUTC6(instante)).getTime()).toBe(
        instante.getTime(),
      );
    });

    it('una apertura de caja de las 08:00 se compara como las 14:00 UTC', () => {
      const aperturaEnLaBase = new Date('2026-09-29T08:00:00.000Z'); // 08:00 en taquilla

      expect(aInstanteReal(aperturaEnLaBase).toISOString()).toBe(
        '2026-09-29T14:00:00.000Z',
      );
    });

    it('una venta anterior a la apertura queda por debajo del piso convertido', () => {
      const apertura = aInstanteReal(new Date('2026-09-29T08:00:00.000Z'));
      const ventaA5am = new Date('2026-09-29T11:00:00.000Z'); // 05:00 en taquilla

      // Sin convertir el piso, esta comparación daba `false` y la venta pasaba.
      expect(ventaA5am < apertura).toBe(true);
    });

    it('una venta dentro del turno sigue pasando', () => {
      const apertura = aInstanteReal(new Date('2026-09-29T08:00:00.000Z'));
      const ventaA10am = new Date('2026-09-29T16:00:00.000Z'); // 10:00 en taquilla

      expect(ventaA10am < apertura).toBe(false);
    });
  });

  describe('anioDeNegocio: el año que numera los folios', () => {
    /**
     * El caso que estaba mal. A las 02:00 del 1 de enero en Guatemala ya es el año
     * nuevo, pero leer `getFullYear()` sobre la fecha ya desplazada respondía el año
     * viejo, y el correlativo seguía la serie anterior durante seis horas.
     */
    it('a las 02:00 del 1 de enero en Guatemala ya es el año nuevo', () => {
      const madrugada = new Date('2027-01-01T08:00:00.000Z'); // 02:00 en Guatemala

      expect(anioDeNegocio(madrugada)).toBe(2027);
    });

    it('a las 23:00 del 31 de diciembre en Guatemala sigue siendo el año viejo', () => {
      const nochevieja = new Date('2027-01-01T05:00:00.000Z'); // 23:00 del 31 en GT

      expect(anioDeNegocio(nochevieja)).toBe(2026);
    });

    it('devuelve un número, no un texto: lo consume el correlativo', () => {
      expect(typeof anioDeNegocio()).toBe('number');
    });
  });

  describe('enHoraDeNegocio: la jornada que vence a las 06:00', () => {
    /**
     * `setHours(6)` fijaba las 06:00 del proceso. Con el servidor en UTC eso era
     * medianoche en la taquilla: el lote vencía seis horas antes, en plena madrugada
     * de trabajo, y los folios dejaban de servir sin que nadie entendiera por qué.
     */
    it('las 06:00 del día siguiente son las 06:00 de Guatemala', () => {
      const tarde = new Date('2026-09-28T20:00:00.000Z'); // 14:00 en Guatemala

      const expira = enHoraDeNegocio(6, 1, tarde);

      // La base guarda el reloj de pared, así que los campos UTC del valor SON las
      // 06:00 que verá el taquillero.
      expect(expira.toISOString()).toBe('2026-09-29T06:00:00.000Z');
    });

    it('cruza el fin de mes sin inventar un día 32', () => {
      const ultimoDeMes = new Date('2026-09-30T20:00:00.000Z');

      expect(enHoraDeNegocio(6, 1, ultimoDeMes).toISOString()).toBe(
        '2026-10-01T06:00:00.000Z',
      );
    });

    // Una venta a las 23:00 de Guatemala del 31 de diciembre vence el 1 de enero.
    it('cruza el fin de año', () => {
      const nochevieja = new Date('2027-01-01T05:00:00.000Z');

      expect(enHoraDeNegocio(6, 1, nochevieja).toISOString()).toBe(
        '2027-01-01T06:00:00.000Z',
      );
    });

    it('sin desplazamiento da esa hora del día en curso', () => {
      const instante = new Date('2026-09-28T20:00:00.000Z');

      expect(enHoraDeNegocio(6, 0, instante).toISOString()).toBe(
        '2026-09-28T06:00:00.000Z',
      );
    });
  });

  describe('diaDeNegocio', () => {
    it('el día cambia a la medianoche de Guatemala, no a la del servidor', () => {
      // 05:30 UTC del 1 de enero = 23:30 del 31 de diciembre en Guatemala.
      expect(diaDeNegocio(new Date('2027-01-01T05:30:00.000Z'))).toBe(
        '2026-12-31',
      );
      // 06:30 UTC ya es el 1 de enero allá (00:30).
      expect(diaDeNegocio(new Date('2027-01-01T06:30:00.000Z'))).toBe(
        '2027-01-01',
      );
    });
  });
});
