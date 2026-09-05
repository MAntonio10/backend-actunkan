import { resolverTarifaEn, resolverTarifaGuiaEn } from './resolver-tarifa.util';
import { getFechaUTC6 } from '../common/utils/date.util';

const CLAVE = { idAtraccion: 1, idOrigen: 1, idTipoVisitante: 1 };

describe('resolverTarifaEn', () => {
  let tx: any;

  beforeEach(() => {
    tx = {
      tarifa: { findFirst: jest.fn().mockResolvedValue({ id: 1, precio: '20.0000' }) },
      tarifaGuia: { findFirst: jest.fn().mockResolvedValue({ id: 1, precio: '15.0000' }) },
    };
  });

  const whereDe = () => tx.tarifa.findFirst.mock.calls[0][0].where;

  it('exige que la vigencia haya empezado', async () => {
    const fecha = new Date('2026-08-20T14:00:00.000Z');
    await resolverTarifaEn(tx, CLAVE, fecha);

    expect(whereDe().vigenteDesde).toEqual({ lte: getFechaUTC6(fecha) });
  });

  // `vigenteHasta` nulo = tarifa abierta, la que rige hoy.
  it('acepta tanto la tarifa abierta como una que aún no había terminado', async () => {
    const fecha = new Date('2026-08-20T14:00:00.000Z');
    await resolverTarifaEn(tx, CLAVE, fecha);

    expect(whereDe().OR).toEqual([
      { vigenteHasta: null },
      { vigenteHasta: { gt: getFechaUTC6(fecha) } },
    ]);
  });

  /**
   * Al cambiar un precio, la fila vieja se cierra con `vigenteHasta = t` y la nueva
   * abre con `vigenteDesde = t`. Con `>=` en lugar de `>` ambas aplicarían en el
   * instante `t` y el precio dependería del orden de las filas.
   */
  it('usa desigualdad estricta en vigenteHasta, para que el instante del cambio no sea ambiguo', async () => {
    await resolverTarifaEn(tx, CLAVE, new Date());

    const condicionFin = whereDe().OR[1].vigenteHasta;
    expect(condicionFin).toHaveProperty('gt');
    expect(condicionFin).not.toHaveProperty('gte');
  });

  /**
   * `vigenteDesde` y `vigenteHasta` se sellan con `getFechaUTC6()`. Comparar contra
   * ellas una marca de tiempo real deja 6 horas en las que una tarifa recién creada
   * parece no existir todavía.
   */
  it('convierte el instante real al reloj desplazado que usa la base', async () => {
    const real = new Date('2026-08-20T14:00:00.000Z');
    await resolverTarifaEn(tx, CLAVE, real);

    const usado: Date = whereDe().vigenteDesde.lte;
    expect(usado.getTime()).toBe(real.getTime() - 6 * 60 * 60 * 1000);
  });

  it('nunca devuelve tarifas anuladas', async () => {
    await resolverTarifaEn(tx, CLAVE, new Date());

    expect(whereDe().anulado).toBe(false);
  });

  it('filtra por la combinación completa de atracción, origen y categoría', async () => {
    await resolverTarifaEn(tx, { idAtraccion: 2, idOrigen: 3, idTipoVisitante: 4 }, new Date());

    expect(whereDe()).toMatchObject({ idAtraccion: 2, idOrigen: 3, idTipoVisitante: 4 });
  });

  // Si un error de datos dejara ventanas superpuestas, el precio no puede salir al azar.
  it('ante ventanas superpuestas prefiere la más reciente ya iniciada', async () => {
    await resolverTarifaEn(tx, CLAVE, new Date());

    expect(tx.tarifa.findFirst.mock.calls[0][0].orderBy).toEqual({ vigenteDesde: 'desc' });
  });

  it('devuelve null cuando no había tarifa cargada en esa fecha', async () => {
    tx.tarifa.findFirst.mockResolvedValue(null);

    await expect(resolverTarifaEn(tx, CLAVE, new Date('2020-01-01'))).resolves.toBeNull();
  });

  it('sin fecha explícita resuelve la de ahora', async () => {
    const antes = getFechaUTC6().getTime();
    await resolverTarifaEn(tx, CLAVE);
    const despues = getFechaUTC6().getTime();

    const usado: Date = whereDe().vigenteDesde.lte;
    expect(usado.getTime()).toBeGreaterThanOrEqual(antes);
    expect(usado.getTime()).toBeLessThanOrEqual(despues);
  });
});

describe('resolverTarifaGuiaEn', () => {
  let tx: any;

  beforeEach(() => {
    tx = { tarifaGuia: { findFirst: jest.fn().mockResolvedValue({ id: 1, precio: '15.0000' }) } };
  });

  it('aplica la misma ventana de vigencia', async () => {
    const fecha = new Date('2026-08-20T14:00:00.000Z');
    await resolverTarifaGuiaEn(tx, fecha);

    const where = tx.tarifaGuia.findFirst.mock.calls[0][0].where;
    expect(where.vigenteDesde).toEqual({ lte: getFechaUTC6(fecha) });
    expect(where.OR[1].vigenteHasta).toHaveProperty('gt');
  });

  // El precio del guía es único: no depende de atracción ni de origen.
  it('no filtra por atracción ni origen', async () => {
    await resolverTarifaGuiaEn(tx, new Date());

    const where = tx.tarifaGuia.findFirst.mock.calls[0][0].where;
    expect(where.idAtraccion).toBeUndefined();
    expect(where.idOrigen).toBeUndefined();
  });

  it('devuelve null si no había tarifa de guía en esa fecha', async () => {
    tx.tarifaGuia.findFirst.mockResolvedValue(null);

    await expect(resolverTarifaGuiaEn(tx, new Date('2020-01-01'))).resolves.toBeNull();
  });
});
