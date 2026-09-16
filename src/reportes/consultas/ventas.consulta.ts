import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FiltrosResueltos } from '../contratos';
import { aDecimal, aEntero } from '../formato.util';
import {
  ClaveAgrupacion,
  ClaveDimension,
  DIMENSIONES,
  DIMENSIONES_TIEMPO,
  esClaveTiempo,
} from './dimensiones';

/**
 * Consultas de venta compartidas por los ocho reportes de tickets.
 *
 * Un solo lugar define qué es "una venta que cuenta". Si cada definición armara su
 * propio `where`, tarde o temprano dos reportes del mismo período darían cifras
 * distintas y nadie sabría cuál creer.
 *
 * **Los anulados nunca suman dinero.** Un ticket anulado no cobró nada, no dejó entrar
 * a nadie y ya salió del arqueo de su caja; contarlo mostraría una recaudación que no
 * existe. Es la misma regla que aplica `TicketsService.findAll`.
 *
 * En este archivo está prohibido `$queryRawUnsafe` y `Prisma.raw(variable)`. Los
 * fragmentos SQL se construyen con `Prisma.sql`, que parametriza todo lo interpolado.
 */

/** Filtro base de una venta vigente en el período. */
export function whereVentas(f: FiltrosResueltos): Prisma.TicketWhereInput {
  return {
    anulado: false,
    // `lt` y no `lte`: el borde superior del rango es exclusivo (ver rango-negocio.util).
    fechaCreacion: { gte: f.desde, lt: f.hasta },
    ...(f.idUsuario ? { idUsuario: f.idUsuario } : {}),
    ...(f.idAtraccion ? { idAtraccion: f.idAtraccion } : {}),
    ...(f.idOrigen ? { idOrigen: f.idOrigen } : {}),
    ...(f.idPais ? { idPais: f.idPais } : {}),
    ...(f.idGuia ? { idGuia: f.idGuia } : {}),
    ...(f.idTipoRecorrido ? { idTipoRecorrido: f.idTipoRecorrido } : {}),
    ...(f.idAperturaCaja ? { idAperturaCaja: f.idAperturaCaja } : {}),
    ...(f.idOpcionPago
      ? {
          ticketPagos: {
            some: { idOpcionPago: f.idOpcionPago, anulado: false },
          },
        }
      : {}),
  };
}

/** El mismo filtro sobre los tickets anulados: se reportan aparte, nunca sumados. */
export function whereVentasAnuladas(
  f: FiltrosResueltos,
): Prisma.TicketWhereInput {
  return { ...whereVentas(f), anulado: true };
}

export interface MetricasVentas {
  tickets: number;
  personas: number;
  recaudado: Prisma.Decimal;
  ticketPromedio: Prisma.Decimal;
  ticketsAnulados: number;
  montoAnulado: Prisma.Decimal;
}

/** KPIs del período. Dos agregados: uno de vigentes, otro de anulados. */
export async function metricasVentas(
  prisma: PrismaService,
  f: FiltrosResueltos,
): Promise<MetricasVentas> {
  const [vigentes, anulados] = await Promise.all([
    prisma.ticket.aggregate({
      where: whereVentas(f),
      _sum: { montoTotal: true, cantidadPersonas: true },
      _count: { _all: true },
    }),
    prisma.ticket.aggregate({
      where: whereVentasAnuladas(f),
      _sum: { montoTotal: true },
      _count: { _all: true },
    }),
  ]);

  const tickets = vigentes._count._all ?? 0;
  const recaudado = aDecimal(vigentes._sum.montoTotal);

  return {
    tickets,
    personas: aEntero(vigentes._sum.cantidadPersonas),
    recaudado,
    // El promedio se calcula con Decimal: AVG() de SQL Server devuelve DECIMAL(38,6)
    // y arrastra ceros que después hay que limpiar.
    ticketPromedio:
      tickets > 0 ? recaudado.div(tickets) : new Prisma.Decimal(0),
    ticketsAnulados: anulados._count._all ?? 0,
    montoAnulado: aDecimal(anulados._sum.montoTotal),
  };
}

export interface FilaAgrupada {
  grupo: string;
  tickets: number;
  personas: number;
  total: string;
}

/**
 * Desglose por dimensión. Una sola ruta de consulta para los cuatro reportes
 * "ventas por ...": el `groupBy` va sobre la FK escalar y los nombres se resuelven
 * después con los ids que de verdad aparecieron.
 */
export async function agruparVentasPor(
  prisma: PrismaService,
  dimension: ClaveDimension,
  f: FiltrosResueltos,
): Promise<FilaAgrupada[]> {
  const dim = DIMENSIONES[dimension];

  const grupos = await prisma.ticket.groupBy({
    by: [dim.campo] as any,
    where: whereVentas(f),
    _sum: { montoTotal: true, cantidadPersonas: true },
    _count: { _all: true },
    orderBy: { _sum: { montoTotal: 'desc' } },
  });

  const ids = (grupos as any[])
    .map((g) => g[dim.campo] as number | null)
    .filter((id): id is number => id !== null);

  const nombres = await dim.resolverNombres(prisma, ids);

  return (grupos as any[]).map((g) => {
    const id = g[dim.campo] as number | null;
    return {
      grupo: id === null ? dim.etiquetaNula : (nombres.get(id) ?? `#${id}`),
      tickets: g._count._all ?? 0,
      personas: aEntero(g._sum.cantidadPersonas),
      total: aDecimal(g._sum.montoTotal).toFixed(4),
    };
  });
}

/**
 * Condiciones SQL equivalentes a `whereVentas`, para lo que `groupBy` no puede
 * expresar. Todo valor va interpolado en `Prisma.sql`, o sea parametrizado.
 */
function condicionesSqlVentas(f: FiltrosResueltos): Prisma.Sql[] {
  const condiciones: Prisma.Sql[] = [
    Prisma.sql`t.anulado = 0`,
    // El filtro va sobre la columna cruda. Envolverla en CAST(... AS DATE) mataría el
    // seek sobre @@index([fechaCreacion]) y forzaría un scan de la tabla entera.
    Prisma.sql`t.fechaCreacion >= ${f.desde}`,
    Prisma.sql`t.fechaCreacion < ${f.hasta}`,
  ];

  if (f.idUsuario) condiciones.push(Prisma.sql`t.idUsuario = ${f.idUsuario}`);
  if (f.idAtraccion)
    condiciones.push(Prisma.sql`t.idAtraccion = ${f.idAtraccion}`);
  if (f.idOrigen) condiciones.push(Prisma.sql`t.idOrigen = ${f.idOrigen}`);
  if (f.idPais) condiciones.push(Prisma.sql`t.idPais = ${f.idPais}`);
  if (f.idGuia) condiciones.push(Prisma.sql`t.idGuia = ${f.idGuia}`);
  if (f.idTipoRecorrido)
    condiciones.push(Prisma.sql`t.idTipoRecorrido = ${f.idTipoRecorrido}`);
  if (f.idAperturaCaja)
    condiciones.push(Prisma.sql`t.idAperturaCaja = ${f.idAperturaCaja}`);
  if (f.idOpcionPago) {
    condiciones.push(
      Prisma.sql`EXISTS (SELECT 1 FROM [dbo].[TicketPago] tp WHERE tp.idTicket = t.id AND tp.idOpcionPago = ${f.idOpcionPago} AND tp.anulado = 0)`,
    );
  }

  // Día de la semana. La misma aritmética que la agrupación `diaSemana`, para
  // que filtrar por sábado y agrupar por día de la semana no puedan discrepar.
  // No hay índice que ayude —la expresión no es sargable—, pero el rango de
  // fechas ya acotó la tabla antes de llegar aquí.
  if (f.diaSemana !== undefined) {
    condiciones.push(
      Prisma.sql`(DATEPART(weekday, t.fechaCreacion) + @@DATEFIRST - 1) % 7 = ${f.diaSemana}`,
    );
  }

  return condiciones;
}

interface FilaDiaCruda {
  dia: string;
  tickets: number | bigint;
  personas: number | bigint | null;
  total: Prisma.Decimal | string | number | null;
}

export interface FilaDia {
  dia: string;
  tickets: number;
  personas: number;
  total: string;
}

/**
 * Serie diaria. Es el único desglose que obliga a SQL crudo: el `groupBy` de Prisma no
 * sabe truncar una fecha.
 *
 * La fecha se devuelve como `char(10)` y no como `DATE`: si saliera como `Date`, Node
 * la reinterpretaría según la zona del proceso y un `toISOString()` posterior podría
 * correrla un día entero. Como texto ISO no hay nada que reinterpretar, y ordena igual
 * de bien lexicográficamente que cronológicamente.
 *
 * Tampoco hace falta ningún `DATEADD` para llevarla a hora local: `getFechaUTC6()` ya
 * aplicó el desfase al escribir, así que lo almacenado es hora de pared.
 */
export async function ventasPorDia(
  prisma: PrismaService,
  f: FiltrosResueltos,
): Promise<FilaDia[]> {
  const filas = await prisma.$queryRaw<FilaDiaCruda[]>`
    SELECT CONVERT(char(10), t.fechaCreacion, 23) AS dia,
           COUNT(*)                               AS tickets,
           ISNULL(SUM(t.cantidadPersonas), 0)     AS personas,
           ISNULL(SUM(t.montoTotal), 0)           AS total
    FROM [dbo].[Ticket] AS t
    WHERE ${Prisma.join(condicionesSqlVentas(f), ' AND ')}
    GROUP BY CONVERT(char(10), t.fechaCreacion, 23)
    ORDER BY dia ASC`;

  return filas.map((fila) => ({
    dia: fila.dia,
    tickets: aEntero(fila.tickets),
    personas: aEntero(fila.personas),
    total: aDecimal(fila.total).toFixed(4),
  }));
}

export interface FilaTipoVisitante {
  tipoVisitante: string;
  personas: number;
  subtotal: string;
}

/**
 * Desglose por categoría de visitante. Agrega la tabla hija filtrando por el ticket
 * padre: el `where` de `groupBy` acepta condiciones de relación, así que no hace falta
 * SQL crudo.
 *
 * Al comparar con los demás reportes hay que tener presente que los tickets de tipo
 * `GUIA` no tienen filas en `VisitantePorTicket`, así que este total es menor que el
 * recaudado general. Va dicho en las notas del reporte.
 */
export async function ventasPorTipoVisitante(
  prisma: PrismaService,
  f: FiltrosResueltos,
): Promise<FilaTipoVisitante[]> {
  const grupos = await prisma.visitantePorTicket.groupBy({
    by: ['idTipoVisitante'],
    where: { tickets: whereVentas(f) },
    _sum: { cantidad: true, subtotal: true },
    orderBy: { _sum: { subtotal: 'desc' } },
  });

  const catalogo = await prisma.tipoVisitante.findMany({
    where: { id: { in: grupos.map((g) => g.idTipoVisitante) } },
    select: { id: true, nombre: true },
  });
  const nombres = new Map(catalogo.map((c) => [c.id, c.nombre]));

  return grupos.map((g) => ({
    tipoVisitante: nombres.get(g.idTipoVisitante) ?? `#${g.idTipoVisitante}`,
    personas: aEntero(g._sum.cantidad),
    subtotal: aDecimal(g._sum.subtotal).toFixed(4),
  }));
}

export interface FilaFormaPago {
  formaPago: string;
  estadoPago: string;
  pagos: number;
  total: string;
}

/**
 * Desglose por forma de pago y estado.
 *
 * Se separan los estados en vez de sumarlos todos: una tarjeta `PENDIENTE` es un cobro
 * que la pasarela todavía no confirmó, y meterla en el mismo renglón que el efectivo
 * inflaría el ingreso con dinero que puede no llegar nunca.
 */
export async function ventasPorFormaPago(
  prisma: PrismaService,
  f: FiltrosResueltos,
): Promise<FilaFormaPago[]> {
  const grupos = await prisma.ticketPago.groupBy({
    by: ['idOpcionPago', 'estadoPago'],
    where: { anulado: false, tickets: whereVentas(f) },
    _sum: { monto: true },
    _count: { _all: true },
    orderBy: { _sum: { monto: 'desc' } },
  });

  const catalogo = await prisma.opcionPago.findMany({
    where: { id: { in: grupos.map((g) => g.idOpcionPago) } },
    select: { id: true, nombre: true },
  });
  const nombres = new Map(catalogo.map((c) => [c.id, c.nombre]));

  return grupos.map((g) => ({
    formaPago: nombres.get(g.idOpcionPago) ?? `#${g.idOpcionPago}`,
    estadoPago: g.estadoPago,
    pagos: g._count._all ?? 0,
    total: aDecimal(g._sum.monto).toFixed(4),
  }));
}

export interface FilaFlexible {
  /** Clave cruda del primer corte; ya presentada para leer. */
  grupo1: string;
  grupo2?: string;
  /** Clave sin presentar, para ordenar cronológicamente. */
  orden1: string;
  orden2?: string;
  tickets: number;
  personas: number;
  total: string;
}

interface CrudaFlexible {
  g1: string | number | null;
  g2?: string | number | null;
  tickets: number | bigint;
  personas: number | bigint | null;
  total: Prisma.Decimal | string | number | null;
}

/**
 * Expresión SQL de una agrupación, sea de catálogo o de tiempo.
 *
 * Las dos salen de una lista blanca escrita en el código, nunca de la petición:
 * lo que llega del cliente o de la IA es solo la clave que indexa esa lista. Por
 * eso no hay `Prisma.raw` de una variable en ninguna parte.
 */
function expresionDe(clave: ClaveAgrupacion): Prisma.Sql {
  if (esClaveTiempo(clave)) return DIMENSIONES_TIEMPO[clave].expresion;
  return COLUMNAS_DIMENSION[clave as ClaveDimension];
}

/** Columnas escalares de `Ticket`, como fragmentos literales. */
const COLUMNAS_DIMENSION: Record<ClaveDimension, Prisma.Sql> = {
  vendedor: Prisma.sql`t.idUsuario`,
  atraccion: Prisma.sql`t.idAtraccion`,
  origen: Prisma.sql`t.idOrigen`,
  pais: Prisma.sql`t.idPais`,
  tipoRecorrido: Prisma.sql`t.idTipoRecorrido`,
  guia: Prisma.sql`t.idGuia`,
};

/** Traduce las claves crudas de una agrupación a lo que lee una persona. */
async function presentarClaves(
  prisma: PrismaService,
  clave: ClaveAgrupacion,
  valores: Array<string | number | null>,
): Promise<Map<string, string>> {
  if (esClaveTiempo(clave)) {
    const dim = DIMENSIONES_TIEMPO[clave];
    return new Map(
      valores
        .filter((valor): valor is string | number => valor !== null)
        .map((valor) => [String(valor), dim.presentar(String(valor))]),
    );
  }

  const dim = DIMENSIONES[clave as ClaveDimension];
  const ids = valores
    .map((valor) => (valor === null ? null : Number(valor)))
    .filter((valor): valor is number => valor !== null && Number.isFinite(valor));
  const nombres = await dim.resolverNombres(prisma, ids);

  return new Map(
    valores.map((valor) => [
      String(valor),
      valor === null
        ? dim.etiquetaNula
        : (nombres.get(Number(valor)) ?? `#${valor}`),
    ]),
  );
}

/**
 * Desglose de ventas por una o dos agrupaciones cualesquiera.
 *
 * Es la consulta del reporte a medida, y va en SQL crudo por una razón: los
 * cortes de tiempo truncan la fecha, y `groupBy` de Prisma no sabe hacerlo. Una
 * sola ruta atiende los cuatro casos (catálogo o tiempo, simple o cruzado) para
 * que un desglose por mes y uno por guía no puedan discrepar en qué venta
 * cuenta; el `where` es el mismo `condicionesSqlVentas` que usa la serie diaria.
 */
export async function agruparVentasFlexible(
  prisma: PrismaService,
  clave1: ClaveAgrupacion,
  clave2: ClaveAgrupacion | undefined,
  f: FiltrosResueltos,
): Promise<FilaFlexible[]> {
  const e1 = expresionDe(clave1);
  const condiciones = Prisma.join(condicionesSqlVentas(f), ' AND ');

  const seleccion = clave2
    ? Prisma.sql`${e1} AS g1, ${expresionDe(clave2)} AS g2`
    : Prisma.sql`${e1} AS g1`;
  const agrupacion = clave2
    ? Prisma.sql`${e1}, ${expresionDe(clave2)}`
    : Prisma.sql`${e1}`;

  const filas = await prisma.$queryRaw<CrudaFlexible[]>`
    SELECT ${seleccion},
           COUNT(*)                           AS tickets,
           ISNULL(SUM(t.cantidadPersonas), 0) AS personas,
           ISNULL(SUM(t.montoTotal), 0)       AS total
    FROM [dbo].[Ticket] AS t
    WHERE ${condiciones}
    GROUP BY ${agrupacion}`;

  const [nombres1, nombres2] = await Promise.all([
    presentarClaves(prisma, clave1, filas.map((fila) => fila.g1)),
    clave2
      ? presentarClaves(prisma, clave2, filas.map((fila) => fila.g2 ?? null))
      : Promise.resolve(new Map<string, string>()),
  ]);

  return filas.map((fila) => ({
    grupo1: nombres1.get(String(fila.g1)) ?? String(fila.g1),
    orden1: String(fila.g1 ?? ''),
    ...(clave2
      ? {
          grupo2: nombres2.get(String(fila.g2 ?? null)) ?? String(fila.g2),
          orden2: String(fila.g2 ?? ''),
        }
      : {}),
    tickets: aEntero(fila.tickets),
    personas: aEntero(fila.personas),
    total: aDecimal(fila.total).toFixed(4),
  }));
}
