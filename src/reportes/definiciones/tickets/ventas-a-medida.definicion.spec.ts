import { EspecificacionReporte, FiltrosResueltos } from '../../contratos';
import { ventasAMedida } from './ventas-a-medida.definicion';

/**
 * Pruebas del reporte a medida: el que ejecutan casi todas las peticiones
 * escritas ("qué guía trabajó más los sábados", "los 5 que más vendieron",
 * "agosto contra septiembre").
 *
 * La aserción que se repite en todo el archivo es una sola: **el indicador de
 * arriba tiene que decir lo mismo que la fila de totales de la tabla**. Quien
 * lee un reporte compara esas dos cifras, y si no cuadran deja de creerle al
 * sistema entero. El caso que las separaba era el top N: los indicadores
 * sumaban todas las agrupaciones y la tabla mostraba solo las primeras.
 *
 * No tocan la base: se simula `$queryRaw` con las filas ya agrupadas, que es
 * exactamente lo que devuelve SQL Server, y los catálogos de nombres.
 */

interface FilaCruda {
  g1: string | number | null;
  g2?: string | number | null;
  tickets: number | bigint;
  personas: number | bigint;
  total: string;
}

const EJECUTOR = { id: 7, email: 'supervisor@actunkan.gt' };

const FILTROS_BASE: FiltrosResueltos = {
  desde: new Date('2026-01-01T00:00:00.000Z'),
  hasta: new Date('2027-01-01T00:00:00.000Z'),
  desdeIso: '2026-01-01',
  hastaIso: '2026-12-31',
  etiquetaPeriodo: '1 de enero al 31 de diciembre de 2026',
  aplicados: [],
};

/**
 * Los sábados de 2026 tal como están en la base de desarrollo: un grupo sin
 * guía por Q60 y uno de Carlos García por Q40. Es el caso que se reportó —la
 * tarjeta decía Q100 y la primera fila Q60—, así que se conserva tal cual.
 */
const SABADOS_POR_GUIA: FilaCruda[] = [
  { g1: null, tickets: 1, personas: 3, total: '60.0000' },
  { g1: 3, tickets: 1, personas: 2, total: '40.0000' },
];

async function ejecutar(opciones: {
  filas: FilaCruda[];
  filtros?: Partial<FiltrosResueltos>;
  limiteFilas?: number;
}): Promise<{ reporte: EspecificacionReporte; prisma: any }> {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue(opciones.filas),
    guia: {
      findMany: jest.fn().mockResolvedValue([{ id: 3, nombre: 'Carlos Garcia' }]),
    },
    usuario: {
      findMany: jest.fn().mockResolvedValue([
        { id: 4, nombre: 'Giselle Pereira' },
        { id: 1, nombre: 'Romeo Santos' },
      ]),
    },
    atraccion: {
      findMany: jest.fn().mockResolvedValue([
        { id: 1, nombre: 'Cuevas Actun Kan' },
        { id: 2, nombre: 'Mariposario' },
      ]),
    },
  };

  const reporte = await ventasAMedida.ejecutar({
    prisma,
    filtros: { ...FILTROS_BASE, ...opciones.filtros },
    ejecutor: EJECUTOR,
    esSupervisor: true,
    limiteFilas: opciones.limiteFilas ?? 5000,
  });

  return { reporte, prisma };
}

/** Cifra de un indicador, sin la Q ni los separadores de miles. */
function kpi(reporte: EspecificacionReporte, etiqueta: string): number {
  const encontrado = reporte.kpis.find((k) => k.etiqueta === etiqueta);
  if (!encontrado) throw new Error(`No hay indicador '${etiqueta}'`);
  return Number(encontrado.valor.replace(/[Q,]/g, ''));
}

function detalleDe(reporte: EspecificacionReporte, etiqueta: string) {
  return reporte.kpis.find((k) => k.etiqueta === etiqueta)?.detalle;
}

/** Lo que suma la fila de totales de la tabla, en la columna pedida. */
function total(reporte: EspecificacionReporte, columna: string): number {
  return Number(reporte.secciones[0].totales?.[columna] ?? 0);
}

describe('ventas-a-medida', () => {
  describe('los indicadores cuadran con la fila de totales', () => {
    it('sin recorte: la tarjeta suma todas las filas de la tabla', async () => {
      const { reporte } = await ejecutar({
        filas: SABADOS_POR_GUIA,
        filtros: { dimension: 'guia', diaSemana: 6 },
      });

      expect(reporte.secciones[0].filas).toHaveLength(2);
      expect(kpi(reporte, 'Recaudado')).toBe(100);
      expect(total(reporte, 'total')).toBe(100);
      expect(kpi(reporte, 'Tickets emitidos')).toBe(total(reporte, 'tickets'));
      expect(kpi(reporte, 'Personas')).toBe(total(reporte, 'personas'));
      // Nada oculto: no hay por qué hablar de otro total.
      expect(detalleDe(reporte, 'Recaudado')).toBeUndefined();
    });

    /**
     * La regresión. Antes la tarjeta decía Q100 —las dos guías— encima de una
     * tabla que solo mostraba la primera, de Q60.
     */
    it('con top N: la tarjeta cuenta solo las filas mostradas', async () => {
      const { reporte } = await ejecutar({
        filas: SABADOS_POR_GUIA,
        filtros: { dimension: 'guia', diaSemana: 6, tope: 1 },
      });

      expect(reporte.secciones[0].filas).toHaveLength(1);
      expect(kpi(reporte, 'Recaudado')).toBe(60);
      expect(total(reporte, 'total')).toBe(60);
      expect(kpi(reporte, 'Tickets emitidos')).toBe(total(reporte, 'tickets'));
      expect(kpi(reporte, 'Personas')).toBe(total(reporte, 'personas'));
    });

    it('lo que queda fuera del top N se dice, no se pierde', async () => {
      const { reporte } = await ejecutar({
        filas: SABADOS_POR_GUIA,
        filtros: { dimension: 'guia', tope: 1 },
      });

      expect(detalleDe(reporte, 'Recaudado')).toBe('de Q100.00 en el período');
      expect(detalleDe(reporte, 'Personas')).toBe('de 5 en el período');
      expect(reporte.notas?.[0]).toContain('Se muestran 1 de 2 guías');
    });

    it('el ticket promedio se calcula con lo mostrado', async () => {
      const { reporte } = await ejecutar({
        filas: [
          { g1: 3, tickets: 2, personas: 4, total: '100.0000' },
          { g1: null, tickets: 8, personas: 8, total: '40.0000' },
        ],
        filtros: { dimension: 'guia', tope: 1 },
      });

      // Q100 entre 2 tickets, no Q140 entre 10.
      expect(kpi(reporte, 'Ticket promedio')).toBe(50);
    });

    it('en la tabla cruzada la tarjeta cuadra con la columna de total', async () => {
      const { reporte } = await ejecutar({
        filas: [
          { g1: 3, g2: 1, tickets: 1, personas: 2, total: '40.0000' },
          { g1: 3, g2: 2, tickets: 1, personas: 1, total: '25.0000' },
          { g1: null, g2: 1, tickets: 1, personas: 3, total: '60.0000' },
        ],
        filtros: { dimension: 'guia', dimension2: 'atraccion', tope: 1 },
      });

      const filas = reporte.secciones[0].filas;
      expect(filas).toHaveLength(1);
      // El grupo mostrado es el de mayor total: Carlos García con 40 + 25.
      expect(kpi(reporte, 'Recaudado')).toBe(65);
      expect(total(reporte, 'totalFila')).toBe(65);
      expect(kpi(reporte, 'Tickets emitidos')).toBe(2);
    });

    it('ordenando por tickets, la tarjeta sigue cuadrando', async () => {
      const { reporte } = await ejecutar({
        filas: [
          { g1: 3, tickets: 1, personas: 1, total: '90.0000' },
          { g1: null, tickets: 9, personas: 9, total: '30.0000' },
        ],
        filtros: { dimension: 'guia', metrica: 'tickets', tope: 1 },
      });

      // Ordena por tickets: gana la fila de 9 tickets aunque recaude menos.
      expect(reporte.secciones[0].filas[0].tickets).toBe(9);
      expect(kpi(reporte, 'Recaudado')).toBe(30);
      expect(total(reporte, 'total')).toBe(30);
    });

    it('sin ventas no inventa cifras', async () => {
      const { reporte } = await ejecutar({
        filas: [],
        filtros: { dimension: 'guia', diaSemana: 6 },
      });

      expect(kpi(reporte, 'Recaudado')).toBe(0);
      expect(kpi(reporte, 'Ticket promedio')).toBe(0);
      expect(reporte.notas?.[0]).toContain('No hubo ventas');
    });
  });

  describe('filtro por día de la semana', () => {
    /**
     * El filtro solo lo sabe expresar el SQL. Si los indicadores volvieran a
     * salir de la agregada de Prisma, un reporte de sábados mostraría encima el
     * recaudado de toda la semana: por eso se comprueba que la condición viaja
     * en la consulta y que las cifras salen de sus filas.
     */
    it('viaja en la consulta que alimenta la tabla y los indicadores', async () => {
      const { prisma } = await ejecutar({
        filas: SABADOS_POR_GUIA,
        filtros: { dimension: 'guia', diaSemana: 6 },
      });

      // Los fragmentos se reconocen por forma y no con `instanceof`:
      // `Prisma.Sql` no existe como clase en tiempo de ejecución del cliente
      // generado. La consulta lleva varios (selección, agrupación, condiciones).
      const fragmentos = prisma.$queryRaw.mock.calls[0]
        .slice(1)
        .filter(
          (valor: any) =>
            valor && typeof valor === 'object' && typeof valor.sql === 'string',
        ) as Array<{ sql: string; values: unknown[] }>;

      const sql = fragmentos.map((fragmento) => fragmento.sql).join(' ');
      const parametros = fragmentos.flatMap((fragmento) => fragmento.values ?? []);

      expect(sql).toContain('DATEPART(weekday');
      expect(parametros).toContain(6);
    });

    it('la tabla y las tarjetas salen de la misma consulta', async () => {
      const { prisma } = await ejecutar({
        filas: SABADOS_POR_GUIA,
        filtros: { dimension: 'guia', diaSemana: 6 },
      });

      // Una sola consulta de datos: no hay una segunda agregada que pueda
      // aplicar otros filtros y contradecir a la tabla.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('agrupaciones sin valor', () => {
    it('«Sin guía» se explica, porque puede quedar de primera', async () => {
      const { reporte } = await ejecutar({
        filas: SABADOS_POR_GUIA,
        filtros: { dimension: 'guia', diaSemana: 6 },
      });

      expect(reporte.secciones[0].filas[0].grupo).toBe('Sin guía');
      expect(reporte.notas?.join(' ')).toContain('«Sin guía» no es un valor del catálogo');
    });

    it('un corte de tiempo no lleva esa nota', async () => {
      const { reporte } = await ejecutar({
        filas: [
          { g1: '2026-08', tickets: 2, personas: 2, total: '50.0000' },
          { g1: '2026-09', tickets: 3, personas: 3, total: '70.0000' },
        ],
        filtros: { dimension: 'mes' },
      });

      expect(reporte.notas?.join(' ')).not.toContain('no es un valor del catálogo');
      // Los meses se leen en orden, no por recaudación.
      expect(reporte.secciones[0].filas.map((f) => f.grupo)).toEqual([
        'Agosto 2026',
        'Septiembre 2026',
      ]);
      expect(kpi(reporte, 'Recaudado')).toBe(120);
      expect(total(reporte, 'total')).toBe(120);
    });
  });

  describe('invariante en todas las combinaciones', () => {
    const FILAS: FilaCruda[] = [
      { g1: 3, tickets: 2, personas: 5, total: '120.5000' },
      { g1: null, tickets: 1, personas: 3, total: '60.0000' },
      { g1: 4, tickets: 4, personas: 9, total: '215.2500' },
    ];

    const COMBINACIONES: Array<Partial<FiltrosResueltos>> = [
      { dimension: 'guia' },
      { dimension: 'guia', tope: 1 },
      { dimension: 'guia', tope: 2 },
      { dimension: 'guia', metrica: 'personas' },
      { dimension: 'guia', metrica: 'tickets', tope: 2 },
      { dimension: 'vendedor', diaSemana: 0 },
      { dimension: 'vendedor', tope: 1, diaSemana: 6 },
    ];

    it.each(COMBINACIONES)('indicadores = totales con %j', async (filtros) => {
      const { reporte } = await ejecutar({ filas: FILAS, filtros });

      expect(kpi(reporte, 'Recaudado')).toBe(total(reporte, 'total'));
      expect(kpi(reporte, 'Tickets emitidos')).toBe(total(reporte, 'tickets'));
      expect(kpi(reporte, 'Personas')).toBe(total(reporte, 'personas'));
    });

    it('el tope nunca pasa del límite de filas del formato', async () => {
      const { reporte } = await ejecutar({
        filas: FILAS,
        filtros: { dimension: 'guia', tope: 50 },
        limiteFilas: 2,
      });

      expect(reporte.secciones[0].filas).toHaveLength(2);
      expect(kpi(reporte, 'Recaudado')).toBe(total(reporte, 'total'));
    });
  });
});
