import {
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLAVES_REPORTE, REGISTRO_REPORTES } from '../definiciones';
import { IaClienteService } from './ia-cliente.service';
import { InterpretacionService } from './interpretacion.service';
import {
  describirCatalogo,
  esquemaRespuesta,
  promptDelSistema,
} from './prompt';

describe('InterpretacionService', () => {
  let servicio: InterpretacionService;
  let cliente: any;

  /** Respuesta bien formada del modelo. */
  const respuestaValida = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      clave: 'ventas-por-vendedor',
      interpretacion: 'Ventas de Juan en agosto de 2026.',
      formato: 'pdf',
      filtros: { desde: '2026-08-01', hasta: '2026-08-31', vendedor: 'Juan' },
      ...extra,
    });

  beforeEach(async () => {
    cliente = { completarJson: jest.fn(), estaConfigurada: true };

    const modulo = await Test.createTestingModule({
      providers: [
        InterpretacionService,
        { provide: IaClienteService, useValue: cliente },
      ],
    }).compile();

    servicio = modulo.get(InterpretacionService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('traduce una instrucción a clave y filtros', async () => {
    cliente.completarJson.mockResolvedValue(respuestaValida());

    const resultado = await servicio.interpretar(
      'ventas del vendedor Juan en agosto',
    );

    expect(resultado.clave).toBe('ventas-por-vendedor');
    expect(resultado.filtros.vendedor).toBe('Juan');
    expect(resultado.filtros.desde).toBe('2026-08-01');
  });

  /**
   * El endpoint compatible con OpenAI de Gemini no documenta el modo estricto de
   * `json_schema` y sigue en beta: hay que contar con que a veces envuelva el JSON.
   */
  it('acepta una respuesta envuelta en cercas de markdown', async () => {
    cliente.completarJson.mockResolvedValue(
      '```json\n' + respuestaValida() + '\n```',
    );

    await expect(
      servicio.interpretar('ventas de Juan en agosto'),
    ).resolves.toMatchObject({
      clave: 'ventas-por-vendedor',
    });
  });

  describe('formato de salida', () => {
    it('devuelve pdf cuando la instrucción no menciona formato', async () => {
      cliente.completarJson.mockResolvedValue(respuestaValida());
      const resultado = await servicio.interpretar(
        'ventas del vendedor Juan en agosto',
      );
      expect(resultado.formato).toBe('pdf');
    });

    it('devuelve excel solo cuando el modelo lo indica', async () => {
      cliente.completarJson.mockResolvedValue(
        respuestaValida({ formato: 'excel' }),
      );
      const resultado = await servicio.interpretar(
        'ventas de Juan en agosto en excel',
      );
      expect(resultado.formato).toBe('excel');
    });

    it('cae en pdf ante un formato desconocido', async () => {
      cliente.completarJson.mockResolvedValue(
        respuestaValida({ formato: 'csv' }),
      );
      const resultado = await servicio.interpretar('ventas de Juan en csv');
      expect(resultado.formato).toBe('pdf');
    });
  });

  describe('validación defensiva', () => {
    it('reintenta una vez cuando la clave no está en el catálogo, y acierta al segundo', async () => {
      cliente.completarJson
        .mockResolvedValueOnce(
          JSON.stringify({ clave: 'ventas-inventadas', filtros: {} }),
        )
        .mockResolvedValueOnce(respuestaValida());

      const resultado = await servicio.interpretar('algo raro sobre ventas');

      expect(cliente.completarJson).toHaveBeenCalledTimes(2);
      expect(resultado.clave).toBe('ventas-por-vendedor');
    });

    it('manda el error como corrección en el segundo intento', async () => {
      cliente.completarJson
        .mockResolvedValueOnce('no soy json')
        .mockResolvedValueOnce(respuestaValida());

      await servicio.interpretar('ventas de agosto');

      const mensajesDelSegundo = cliente.completarJson.mock.calls[1][0];
      expect(mensajesDelSegundo).toHaveLength(4);
      expect(mensajesDelSegundo[3].content).toContain('no sirve porque');
    });

    /** Nunca un 500: el usuario tiene que poder seguir eligiendo el reporte a mano. */
    it('responde 422 con la lista de reportes tras fallar dos veces', async () => {
      cliente.completarJson.mockResolvedValue('sigue sin ser json');

      await expect(servicio.interpretar('cualquier cosa')).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(cliente.completarJson).toHaveBeenCalledTimes(2);
    });

    it('rechaza unos filtros que la ruta manual no aceptaría', async () => {
      cliente.completarJson.mockResolvedValue(
        JSON.stringify({
          clave: 'ventas-resumen',
          interpretacion: 'x',
          formato: 'pdf',
          // Formato de fecha inválido: es exactamente lo que rechaza GenerarReporteDto.
          filtros: { desde: '01/08/2026' },
        }),
      );

      await expect(
        servicio.interpretar('ventas del 1 de agosto'),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('caché', () => {
    /** La cuota gratuita es el recurso escaso: dos "ventas de hoy" no gastan dos llamadas. */
    it('no vuelve a llamar al proveedor con la misma instrucción', async () => {
      cliente.completarJson.mockResolvedValue(respuestaValida());

      await servicio.interpretar('Ventas de Juan en agosto');
      await servicio.interpretar('  ventas   de JUAN  en agosto ');

      expect(cliente.completarJson).toHaveBeenCalledTimes(1);
    });
  });

  it('propaga el 503 del proveedor sin convertirlo en otra cosa', async () => {
    cliente.completarJson.mockRejectedValue(
      new ServiceUnavailableException('No se pudo contactar al servicio.'),
    );

    await expect(servicio.interpretar('ventas de agosto')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('IaClienteService', () => {
  const claveOriginal = process.env.IA_API_KEY;

  afterEach(() => {
    if (claveOriginal === undefined) delete process.env.IA_API_KEY;
    else process.env.IA_API_KEY = claveOriginal;
    jest.restoreAllMocks();
  });

  it('informa que no está configurada cuando falta la clave', () => {
    delete process.env.IA_API_KEY;
    expect(new IaClienteService().estaConfigurada).toBe(false);
  });

  it('lanza 503 con mensaje claro si se le llama sin clave', async () => {
    delete process.env.IA_API_KEY;
    await expect(new IaClienteService().completarJson([], {})).rejects.toThrow(
      /no está configurada/i,
    );
  });

  it('traduce el 429 de cuota agotada a un mensaje sobre la cuota', async () => {
    process.env.IA_API_KEY = 'clave-de-prueba';
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'quota exceeded',
    } as any);

    await expect(new IaClienteService().completarJson([], {})).rejects.toThrow(
      /cuota/i,
    );
  });

  /**
   * Un 429 por cupo por minuto no es una cuota agotada: se resuelve esperando.
   * Groq cierra todos sus errores de cupo con un enlace a /settings/billing, y
   * buscar 'billing' hacía anunciar «cuota agotada» al segundo reporte seguido.
   */
  it('distingue el cupo por minuto de la cuota agotada', async () => {
    process.env.IA_API_KEY = 'clave-de-prueba';
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      // Espera larga: no se reintenta, pero sí se explica bien.
      headers: { get: (n: string) => (n === 'x-ratelimit-reset-tokens' ? '56s' : null) },
      text: async () =>
        'Rate limit reached for model on tokens per minute (TPM). ' +
        'Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
    } as any);

    const error = await new IaClienteService()
      .completarJson([], {})
      .catch((e) => e);

    expect(error.message).toMatch(/demasiadas peticiones/i);
    expect(error.message).not.toMatch(/cuota/i);
    expect(error.message).toMatch(/56 s/);
  });

  /**
   * Cuando el modelo se niega, el proveedor devuelve 400 `json_validate_failed`
   * con la negativa en `failed_generation`. Eso no es una avería del servicio:
   * anunciarlo como 503 manda al usuario a esperar a que vuelva algo que nunca
   * se cayó, cuando lo que tiene que hacer es reformular.
   */
  it('trata la negativa del modelo como petición no interpretable, no como avería', async () => {
    process.env.IA_API_KEY = 'clave-de-prueba';
    const espia = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          error: {
            code: 'json_validate_failed',
            failed_generation: 'I am sorry, but I can not help with that.',
          },
        }),
    } as any);

    const error = await new IaClienteService()
      .completarJson([], {})
      .catch((e) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.message).toMatch(/no se pudo interpretar/i);
    // Una negativa es determinista: repetirla solo gastaría cuota.
    expect(espia).toHaveBeenCalledTimes(1);
  });

  it('reintenta cuando el modelo intentó el JSON y le salió mal', async () => {
    process.env.IA_API_KEY = 'clave-de-prueba';
    const espia = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          error: {
            code: 'json_validate_failed',
            failed_generation: '{"clave": "ventas-resumen", ',
          },
        }),
    } as any);

    const error = await new IaClienteService()
      .completarJson([], {})
      .catch((e) => e);

    // Tres intentos (principal, principal, respaldo) y, al agotarlos, un 422:
    // el servicio contestó siempre; lo que no servía era la respuesta.
    expect(espia).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
  });

  it('traduce un fallo de red a 503 y no deja escapar el error crudo', async () => {
    process.env.IA_API_KEY = 'clave-de-prueba';
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(new IaClienteService().completarJson([], {})).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

/**
 * El prompt se genera del registro de definiciones, no esta escrito a mano. Estas pruebas
 * vigilan que siga sincronizado: es lo que se pudre en silencio cuando alguien agrega un
 * reporte y nadie se acuerda de tocar la capa de IA.
 */
describe('prompt e interpretacion del catalogo', () => {
  it('describe todos los reportes del registro', () => {
    const descritos = describirCatalogo()
      .split('\n')
      .filter((linea) => linea.startsWith('  * '))
      .map((linea) => linea.slice(4).trim());

    expect(descritos.sort()).toEqual([...CLAVES_REPORTE].sort());
  });

  it('el enum del esquema son exactamente las claves del registro', () => {
    const esquema = esquemaRespuesta() as any;
    expect([...esquema.properties.clave.enum].sort()).toEqual(
      [...REGISTRO_REPORTES.keys()].sort(),
    );
  });

  /**
   * Nombrarle a la IA un filtro que luego no puede escribir es la forma mas facil de que
   * devuelva algo que no valida y se gaste el reintento. Pasa en cuanto alguien declara un
   * filtro nuevo sin anadirlo al esquema.
   */
  it('todo filtro que se le nombra a la IA existe en el esquema de respuesta', () => {
    const esquema = esquemaRespuesta() as any;
    const permitidos = new Set(
      Object.keys(esquema.properties.filtros.properties),
    );

    const nombrados = describirCatalogo()
      .split('\n')
      .map((linea) => linea.match(/^ {6}- ([a-zA-Z]+):/)?.[1])
      .filter((nombre): nombre is string => Boolean(nombre));

    expect(nombrados.length).toBeGreaterThan(0);
    expect(nombrados.filter((nombre) => !permitidos.has(nombre))).toEqual([]);
  });

  /** El rango de fechas es un filtro para el frontend y dos campos para la IA. */
  it('traduce el rango de fechas a desde y hasta', () => {
    // Desde que los filtros repetidos se agrupan en bloques, el rango vive en el
    // bloque [PERÍODO] del prompt y el catálogo lo cita por nombre. Lo que no
    // puede cambiar es que la IA nunca vea un campo 'periodo', que no existe en
    // el DTO y le haría devolver algo que no valida.
    const prompt = promptDelSistema();
    expect(prompt).toContain('- desde:');
    expect(prompt).toContain('- hasta:');
    expect(prompt).not.toContain('- periodo:');
    expect(describirCatalogo()).toContain('[PERÍODO]');
  });

  it('le da a la IA la fecha de hoy para resolver expresiones relativas', () => {
    // Con el día de la semana: sin él, "el fin de semana pasado" salía resuelto
    // como lunes y martes. Calcular el día de una fecha es lo que peor hace un
    // modelo de lenguaje, así que se le da hecho.
    expect(promptDelSistema()).toMatch(
      /Hoy es \d{4}-\d{2}-\d{2} \((lunes|martes|miércoles|jueves|viernes|sábado|domingo)\)/,
    );
  });

  it('le dice explicitamente que no consulta datos ni calcula cifras', () => {
    expect(promptDelSistema()).toContain(
      'No consultas datos, no calculas cifras',
    );
  });
});

/**
 * Las peticiones que la pantalla ofrece como ejemplo.
 *
 * Están elegidas para lucir lo que el catálogo no tiene como botón —un cruce,
 * un top N, un corte por hora o por día de la semana—, y por eso hay que
 * comprobar que se pueden expresar: si alguna dejara de ser resoluble, la
 * pantalla estaría invitando al usuario a gastar cuota de IA en una petición
 * que termina en 400.
 *
 * No se llama al proveedor: se le da ya escrita la traducción que debe producir
 * y se comprueba que el servicio la acepta sin corregirla. Lo que se prueba es
 * el contrato —que esos filtros existen y ese reporte los declara—, no el
 * acierto del modelo.
 */
describe('peticiones de ejemplo de la pantalla', () => {
  let servicio: InterpretacionService;
  let cliente: any;

  const EJEMPLOS = [
    {
      frase: '¿Qué guía trabajó más los sábados este año?',
      clave: 'ventas-a-medida',
      filtros: {
        desde: '2026-01-01',
        hasta: '2026-12-31',
        dimension: 'guia',
        diaSemana: 'sabado',
      },
    },
    {
      frase: 'Las 3 horas de más venta en el mariposario',
      clave: 'ventas-a-medida',
      filtros: { dimension: 'horaDelDia', atraccion: 'mariposario', tope: '3' },
    },
    {
      frase: 'Ventas por atracción cruzadas por país este año',
      clave: 'ventas-a-medida',
      filtros: {
        desde: '2026-01-01',
        hasta: '2026-12-31',
        dimension: 'atraccion',
        dimension2: 'pais',
      },
    },
    {
      frase: 'Tickets de agosto y septiembre, mes por mes',
      clave: 'ventas-a-medida',
      filtros: {
        desde: '2026-08-01',
        hasta: '2026-09-30',
        dimension: 'mes',
        metrica: 'tickets',
      },
    },
    {
      frase: 'Los 5 vendedores que más recaudaron en recorrido largo',
      clave: 'ventas-a-medida',
      filtros: { dimension: 'vendedor', tope: '5', tipoRecorrido: 'largo' },
    },
  ];

  beforeEach(async () => {
    cliente = { completarJson: jest.fn(), estaConfigurada: true };

    const modulo = await Test.createTestingModule({
      providers: [
        InterpretacionService,
        { provide: IaClienteService, useValue: cliente },
      ],
    }).compile();

    servicio = modulo.get(InterpretacionService);
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(EJEMPLOS)('«$frase» la resuelve el catálogo', async (ejemplo) => {
    cliente.completarJson.mockResolvedValue(
      JSON.stringify({
        clave: ejemplo.clave,
        interpretacion: ejemplo.frase,
        formato: 'pdf',
        filtros: ejemplo.filtros,
      }),
    );

    const resultado = await servicio.interpretar(ejemplo.frase);

    expect(resultado.clave).toBe(ejemplo.clave);
    // Un solo intento: si hubiera hecho falta corregir, el reporte no acepta
    // alguno de esos filtros.
    expect(cliente.completarJson).toHaveBeenCalledTimes(1);
    for (const [nombre, valor] of Object.entries(ejemplo.filtros)) {
      expect(String((resultado.filtros as any)[nombre])).toBe(String(valor));
    }
  });

  it('el reporte que usan declara todos esos filtros', () => {
    const definicion = REGISTRO_REPORTES.get('ventas-a-medida')!;
    const declarados = new Set(
      definicion.filtros.flatMap((filtro) =>
        filtro.clave === 'periodo' ? ['desde', 'hasta'] : [filtro.clave],
      ),
    );

    for (const ejemplo of EJEMPLOS) {
      for (const nombre of Object.keys(ejemplo.filtros)) {
        expect([nombre, [...declarados]]).toEqual([
          nombre,
          expect.arrayContaining([nombre]),
        ]);
      }
    }
  });
});
