import {
  PAGINACION_ACTIVIDADES,
  PAGINACION_BITACORA,
  PAGINACION_POR_DEFECTO,
  construirRespuestaPaginada,
  resolverPaginacion,
} from './paginacion.util';

describe('resolverPaginacion', () => {
  it('sin parámetros arranca en la primera página con el límite general', () => {
    expect(resolverPaginacion()).toEqual({ pagina: 1, limite: 20, skip: 0, take: 20 });
  });

  it('un objeto de consulta vacío se comporta igual que no recibir nada', () => {
    expect(resolverPaginacion({})).toEqual({ pagina: 1, limite: 20, skip: 0, take: 20 });
  });

  it('calcula el salto a partir de la página pedida', () => {
    expect(resolverPaginacion({ pagina: 3, limite: 20 })).toEqual({
      pagina: 3,
      limite: 20,
      skip: 40,
      take: 20,
    });
  });

  // Mismo comportamiento que el bloque copiado al que sustituye: un valor sin
  // sentido no revienta la consulta, cae al valor por defecto.
  it.each([0, -1, undefined, NaN])('la página %p cae a 1', (pagina) => {
    expect(resolverPaginacion({ pagina }).pagina).toBe(1);
  });

  it.each([0, -1, undefined, NaN])('el límite %p cae al valor por defecto', (limite) => {
    expect(resolverPaginacion({ limite }).limite).toBe(20);
  });

  it('recorta el límite al tope en vez de reventar la consulta', () => {
    expect(resolverPaginacion({ limite: 1000 }).limite).toBe(200);
  });

  // Prisma rechaza un `take` decimal: 10.7 filas no existe.
  it('trunca los decimales', () => {
    expect(resolverPaginacion({ pagina: 2.9, limite: 10.7 })).toEqual({
      pagina: 2,
      limite: 10,
      skip: 10,
      take: 10,
    });
  });

  it('una página más allá del total devuelve un salto grande, no un error', () => {
    expect(resolverPaginacion({ pagina: 99999, limite: 10 }).skip).toBe(999980);
  });

  describe('topes propios de cada módulo', () => {
    it('actividades reparte de 20 en 20', () => {
      expect(resolverPaginacion({}, PAGINACION_ACTIVIDADES).limite).toBe(20);
    });

    it('actividades recorta a 100, no a 200', () => {
      expect(resolverPaginacion({ limite: 1000 }, PAGINACION_ACTIVIDADES).limite).toBe(100);
    });

    it('la bitácora reparte igual que el resto', () => {
      expect(resolverPaginacion({}, PAGINACION_BITACORA).limite).toBe(20);
    });

    it('un límite explícito gana sobre el valor por defecto del módulo', () => {
      expect(resolverPaginacion({ limite: 5 }, PAGINACION_ACTIVIDADES).limite).toBe(5);
    });
  });
});

describe('construirRespuestaPaginada', () => {
  const paginacion = resolverPaginacion({ pagina: 2, limite: 10 });

  it('devuelve el sobre con la página, no con el conjunto completo', () => {
    expect(construirRespuestaPaginada([{ id: 1 }], 137, paginacion)).toEqual({
      datos: [{ id: 1 }],
      total: 137,
      pagina: 2,
      limite: 10,
    });
  });

  // El sobre es contrato publicado: si alguien cuela un campo extra, el frontend
  // empieza a depender de algo que no está documentado.
  it('el sobre tiene exactamente cuatro campos', () => {
    expect(Object.keys(construirRespuestaPaginada([], 0, paginacion))).toEqual([
      'datos',
      'total',
      'pagina',
      'limite',
    ]);
  });

  it('un listado vacío conserva el total del filtro', () => {
    const res = construirRespuestaPaginada([], 0, resolverPaginacion({}));
    expect(res.datos).toEqual([]);
    expect(res.total).toBe(0);
  });
});

describe('presets', () => {
  it('el tope general es 20 por página y 200 como máximo', () => {
    expect(PAGINACION_POR_DEFECTO).toEqual({ limitePorDefecto: 20, limiteMaximo: 200 });
  });
});
