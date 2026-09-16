import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EjecutorInfo } from '../../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../../common/utils/date.util';
import { FiltrosResueltos } from '../contratos';
import {
  DIMENSIONES_TIEMPO,
  etiquetasDe,
  type ClaveAgrupacion,
} from '../consultas/dimensiones';
import {
  agruparVentasFlexible,
  metricasVentas,
  ventasPorTipoVisitante,
} from '../consultas/ventas.consulta';
import { aDecimal, separarMiles } from '../formato.util';
import { rangoNegocio } from '../rango-negocio.util';
import type {
  Dashboard,
  FormatoValorDashboard,
  GranoTemporal,
  KpiDashboard,
  PuntoSerie,
  SerieDashboard,
  TipoGraficaSugerido,
} from './dashboard.contratos';

/**
 * Panel de gráficas.
 *
 * Existe porque hasta ahora la única forma de ver una gráfica era generar un
 * reporte: había que saber cuál se quería antes de poder mirar nada. Un panel
 * invierte eso — enseña cómo va el parque y desde ahí se decide qué mirar de
 * cerca—, y para eso necesita datos con otra forma: series cortas listas para
 * dibujar, no tablas con columnas y totales.
 *
 * **No inventa ninguna consulta.** Todo sale de `consultas/ventas.consulta.ts`,
 * las mismas que alimentan los 19 reportes. Eso no es ahorro de código: es lo
 * que garantiza que la cifra del panel y la del reporte impreso coincidan. Si el
 * panel tuviera su propio `where`, tarde o temprano una gráfica diría una cosa y
 * el PDF otra, y nadie sabría cuál creer.
 *
 * Cada serie enlaza además con el reporte del catálogo que muestra lo mismo en
 * tabla (`urlDetalle`), que es el camino natural: se ve el pico en la gráfica y
 * se salta al detalle imprimible.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  private async tienePermiso(
    idUsuario: number,
    modulo: string,
    accion: string,
  ): Promise<boolean> {
    const permiso = await this.prisma.permisos.findFirst({
      where: {
        idUsuario,
        moduloAccion: {
          modulo: { nombre: modulo, anulado: false },
          accion: { nombre: accion },
        },
      },
      select: { id: true },
    });
    return Boolean(permiso);
  }

  /**
   * Cada cuánto agrupar las series temporales, según lo que dure el período.
   *
   * Un año por días son 365 puntos: la gráfica se vuelve una mancha y el payload
   * crece para que nadie lo mire. Los cortes están donde una serie deja de
   * leerse: un mes cabe cómodo por días; hasta unos cuatro meses, por semanas;
   * más allá, por meses. Quien consulta puede forzarlo si quiere el detalle fino.
   */
  private granoPara(filtros: FiltrosResueltos): GranoTemporal {
    const dias = Math.max(
      1,
      Math.round(
        (filtros.hasta.getTime() - filtros.desde.getTime()) / 86_400_000,
      ),
    );
    if (dias <= 31) return 'dia';
    if (dias <= 120) return 'semana';
    return 'mes';
  }

  private etiquetaGrano(grano: GranoTemporal): string {
    return { dia: 'día', semana: 'semana', mes: 'mes' }[grano];
  }

  private moneda(valor: Prisma.Decimal): string {
    return `Q${separarMiles(valor.toFixed(2))}`;
  }

  private entero(valor: number): string {
    return separarMiles(String(Math.trunc(valor)));
  }

  /** Los puntos van en número: es para dibujar, no para cuadrar cuentas. */
  private aPunto(etiqueta: string, valor: Prisma.Decimal | number, clave?: string): PuntoSerie {
    const numero =
      typeof valor === 'number' ? valor : Number(valor.toFixed(2));
    return { etiqueta, valor: numero, ...(clave ? { clave } : {}) };
  }

  /**
   * Período inmediatamente anterior, de la misma duración.
   *
   * Comparar agosto contra julio cuando el usuario pidió «del 5 al 20» sería
   * comparar quince días contra treinta y uno. Se desplaza la ventana tantos
   * días como dure, que es la única comparación honesta sin preguntar nada.
   */
  private periodoAnterior(filtros: FiltrosResueltos): FiltrosResueltos {
    const dia = 86_400_000;
    const duracion = Math.max(
      1,
      Math.round((filtros.hasta.getTime() - filtros.desde.getTime()) / dia),
    );
    const iso = (fecha: Date) => fecha.toISOString().slice(0, 10);
    const hastaAnterior = new Date(filtros.desde.getTime() - dia);
    const desdeAnterior = new Date(
      hastaAnterior.getTime() - (duracion - 1) * dia,
    );

    const rango = rangoNegocio(iso(desdeAnterior), iso(hastaAnterior));
    return {
      ...filtros,
      desde: rango.desde,
      hasta: rango.hasta,
      desdeIso: iso(desdeAnterior),
      hastaIso: iso(hastaAnterior),
      etiquetaPeriodo: rango.etiqueta,
    };
  }

  private variacion(
    actual: Prisma.Decimal | number,
    anterior: Prisma.Decimal | number,
    etiquetaAnterior: string,
  ): KpiDashboard['variacion'] {
    const a = new Prisma.Decimal(actual.toString());
    const b = new Prisma.Decimal(anterior.toString());

    // Sin base con la que comparar no hay porcentaje: pasar de 0 a 100 no es un
    // crecimiento del infinito por ciento, es un dato que no se puede expresar
    // así. Se omite la variación y el frontend simplemente no la pinta.
    if (b.isZero()) return undefined;

    const fraccion = a.minus(b).div(b);
    return {
      porcentaje: Number(fraccion.toFixed(4)),
      direccion: fraccion.isZero() ? 'igual' : fraccion.isPositive() ? 'sube' : 'baja',
      etiqueta: `vs. ${etiquetaAnterior}`,
    };
  }

  /** Serie a partir de un desglose por dimensión, ya ordenado de mayor a menor. */
  private async seriePorDimension(opciones: {
    clave: string;
    titulo: string;
    descripcion?: string;
    dimension: ClaveAgrupacion;
    filtros: FiltrosResueltos;
    tipoSugerido: TipoGraficaSugerido;
    metrica?: 'total' | 'tickets' | 'personas';
    tope?: number;
    urlDetalle?: string;
  }): Promise<SerieDashboard> {
    const metrica = opciones.metrica ?? 'total';
    const crudas = await agruparVentasFlexible(
      this.prisma,
      opciones.dimension,
      undefined,
      opciones.filtros,
    );

    const esDinero = metrica === 'total';
    const valorDe = (fila: (typeof crudas)[number]) =>
      esDinero ? aDecimal(fila.total) : new Prisma.Decimal(fila[metrica]);

    // Los cortes de tiempo se leen en su orden; el resto, de mayor a menor.
    const cronologico = opciones.dimension in DIMENSIONES_TIEMPO;
    const ordenadas = [...crudas].sort((a, b) =>
      cronologico
        ? a.orden1.localeCompare(b.orden1)
        : valorDe(b).comparedTo(valorDe(a)),
    );

    const total = ordenadas.reduce(
      (suma, fila) => suma.plus(valorDe(fila)),
      new Prisma.Decimal(0),
    );

    const visibles = opciones.tope ? ordenadas.slice(0, opciones.tope) : ordenadas;

    return {
      clave: opciones.clave,
      titulo: opciones.titulo,
      descripcion: opciones.descripcion,
      tipoSugerido: opciones.tipoSugerido,
      formato: esDinero ? 'moneda' : 'entero',
      unidad: esDinero ? 'Recaudado' : metrica === 'tickets' ? 'Tickets' : 'Personas',
      puntos: visibles.map((fila) =>
        this.aPunto(fila.grupo1, valorDe(fila), fila.orden1),
      ),
      total: esDinero ? this.moneda(total) : this.entero(total.toNumber()),
      urlDetalle: opciones.urlDetalle,
    };
  }

  /**
   * Arma el panel completo.
   *
   * Los paneles se piden en paralelo porque son independientes entre sí y el
   * rango de fechas ya acotó cada consulta; en serie, doce viajes a la base
   * harían que el panel tardara más que cualquier reporte.
   */
  async generar(
    filtros: FiltrosResueltos,
    ejecutor: EjecutorInfo,
    granoPedido?: GranoTemporal,
  ): Promise<Dashboard> {
    const grano = granoPedido ?? this.granoPara(filtros);
    const omitidos: Dashboard['omitidos'] = [];
    const [puedeTickets, puedeDonaciones] = await Promise.all([
      this.tienePermiso(ejecutor.id!, 'EmisionTickets', 'Ver'),
      this.tienePermiso(ejecutor.id!, 'Donaciones', 'Ver'),
    ]);

    const anterior = this.periodoAnterior(filtros);
    const kpis: KpiDashboard[] = [];
    const series: SerieDashboard[] = [];
    const query = `desde=${filtros.desdeIso}&hasta=${filtros.hastaIso}`;

    if (!puedeTickets) {
      omitidos.push({
        panel: 'Ventas',
        motivo: 'Necesita el permiso Ver del módulo EmisionTickets.',
      });
    } else {
      const [metricas, metricasAnteriores, porPeriodo, tiposVisitante] =
        await Promise.all([
          metricasVentas(this.prisma, filtros),
          metricasVentas(this.prisma, anterior),
          // El mismo desglose temporal que usa el reporte a medida: así una
          // gráfica por meses del panel y una tabla por meses del catálogo no
          // pueden discrepar en qué venta cae en qué mes.
          agruparVentasFlexible(this.prisma, grano, undefined, filtros),
          ventasPorTipoVisitante(this.prisma, filtros),
        ]);

      const enOrden = [...porPeriodo].sort((a, b) =>
        a.orden1.localeCompare(b.orden1),
      );

      kpis.push(
        {
          clave: 'recaudado',
          etiqueta: 'Recaudado',
          valor: this.moneda(metricas.recaudado),
          formato: 'moneda',
          variacion: this.variacion(
            metricas.recaudado,
            metricasAnteriores.recaudado,
            anterior.etiquetaPeriodo,
          ),
        },
        {
          clave: 'tickets',
          etiqueta: 'Tickets emitidos',
          valor: this.entero(metricas.tickets),
          formato: 'entero',
          variacion: this.variacion(
            metricas.tickets,
            metricasAnteriores.tickets,
            anterior.etiquetaPeriodo,
          ),
        },
        {
          clave: 'personas',
          etiqueta: 'Personas',
          valor: this.entero(metricas.personas),
          formato: 'entero',
          variacion: this.variacion(
            metricas.personas,
            metricasAnteriores.personas,
            anterior.etiquetaPeriodo,
          ),
        },
        {
          clave: 'ticketPromedio',
          etiqueta: 'Ticket promedio',
          valor: this.moneda(metricas.ticketPromedio),
          formato: 'moneda',
          variacion: this.variacion(
            metricas.ticketPromedio,
            metricasAnteriores.ticketPromedio,
            anterior.etiquetaPeriodo,
          ),
        },
        {
          clave: 'anulados',
          etiqueta: 'Tickets anulados',
          valor: this.entero(metricas.ticketsAnulados),
          formato: 'entero',
          variacion: this.variacion(
            metricas.ticketsAnulados,
            metricasAnteriores.ticketsAnulados,
            anterior.etiquetaPeriodo,
          ),
        },
      );

      const totalPeriodo = enOrden.reduce(
        (suma, fila) => suma.plus(aDecimal(fila.total)),
        new Prisma.Decimal(0),
      );
      const detalleTemporal = `/reportes/ventas-a-medida?${query}&dimension=${grano}`;

      series.push(
        {
          clave: 'ventas-por-periodo',
          titulo: `Recaudación por ${this.etiquetaGrano(grano)}`,
          descripcion: 'Cómo se distribuyó el ingreso a lo largo del período.',
          tipoSugerido: 'linea',
          formato: 'moneda',
          unidad: 'Recaudado',
          puntos: enOrden.map((fila) =>
            this.aPunto(fila.grupo1, aDecimal(fila.total), fila.orden1),
          ),
          total: this.moneda(totalPeriodo),
          urlDetalle: detalleTemporal,
        },
        {
          clave: 'tickets-por-periodo',
          titulo: `Tickets por ${this.etiquetaGrano(grano)}`,
          tipoSugerido: 'linea',
          formato: 'entero',
          unidad: 'Tickets',
          puntos: enOrden.map((fila) =>
            this.aPunto(fila.grupo1, fila.tickets, fila.orden1),
          ),
          total: this.entero(enOrden.reduce((suma, fila) => suma + fila.tickets, 0)),
          urlDetalle: `${detalleTemporal}&metrica=tickets`,
        },
        {
          clave: 'personas-por-tipo',
          titulo: 'Visitantes por categoría',
          descripcion:
            'Los tickets de guía no llevan categoría, así que este total es menor que el de personas.',
          tipoSugerido: 'dona',
          formato: 'entero',
          unidad: 'Personas',
          puntos: tiposVisitante.map((fila) =>
            this.aPunto(fila.tipoVisitante, fila.personas),
          ),
          total: this.entero(
            tiposVisitante.reduce((suma, fila) => suma + fila.personas, 0),
          ),
          urlDetalle: `/reportes/ventas-por-tipo-visitante?${query}`,
        },
      );

      const porDimension = await Promise.all([
        this.seriePorDimension({
          clave: 'ventas-por-atraccion',
          titulo: 'Recaudación por atracción',
          dimension: 'atraccion',
          filtros,
          tipoSugerido: 'dona',
          urlDetalle: `/reportes/ventas-por-atraccion?${query}`,
        }),
        this.seriePorDimension({
          clave: 'ventas-por-origen',
          titulo: 'Nacionales y extranjeros',
          dimension: 'origen',
          filtros,
          tipoSugerido: 'dona',
          urlDetalle: `/reportes/ventas-por-origen?${query}`,
        }),
        this.seriePorDimension({
          clave: 'top-vendedores',
          titulo: 'Vendedores que más recaudaron',
          dimension: 'vendedor',
          filtros,
          tipoSugerido: 'barra',
          tope: 8,
          urlDetalle: `/reportes/ventas-por-vendedor?${query}`,
        }),
        this.seriePorDimension({
          clave: 'top-guias',
          titulo: 'Guías que más recaudaron',
          descripcion: '«Sin guía» son los grupos que entraron por su cuenta.',
          dimension: 'guia',
          filtros,
          tipoSugerido: 'embudo',
          tope: 8,
          urlDetalle: `/reportes/ventas-a-medida?${query}&dimension=guia`,
        }),
        this.seriePorDimension({
          clave: 'ventas-por-hora',
          titulo: 'A qué hora se vende',
          descripcion: 'Útil para decidir turnos de taquilla.',
          dimension: 'horaDelDia',
          filtros,
          tipoSugerido: 'barra',
          urlDetalle: `/reportes/ventas-a-medida?${query}&dimension=horaDelDia`,
        }),
        this.seriePorDimension({
          clave: 'ventas-por-dia-semana',
          titulo: 'Qué días entra más gente',
          dimension: 'diaSemana',
          filtros,
          tipoSugerido: 'barra',
          metrica: 'personas',
          urlDetalle: `/reportes/ventas-a-medida?${query}&dimension=diaSemana&metrica=personas`,
        }),
      ]);

      series.push(...porDimension);
    }

    if (!puedeDonaciones) {
      omitidos.push({
        panel: 'Donaciones',
        motivo: 'Necesita el permiso Ver del módulo Donaciones.',
      });
    } else {
      const donaciones = await this.donacionesEnElTiempo(filtros, grano);
      const totalDonado = donaciones.reduce(
        (suma, fila) => suma.plus(fila.total),
        new Prisma.Decimal(0),
      );

      kpis.push({
        clave: 'donado',
        etiqueta: 'Donaciones',
        valor: this.moneda(totalDonado),
        formato: 'moneda',
      });

      series.push({
        clave: 'donaciones-por-periodo',
        titulo: `Donaciones por ${this.etiquetaGrano(grano)}`,
        tipoSugerido: 'barra',
        formato: 'moneda',
        unidad: 'Donado',
        puntos: donaciones.map((fila) =>
          this.aPunto(fila.etiqueta, fila.total, fila.clave),
        ),
        total: this.moneda(totalDonado),
        urlDetalle: `/reportes/donaciones-resumen?${query}`,
      });
    }

    const usuario = await this.prisma.usuario.findUnique({
      where: { id: ejecutor.id },
      select: { nombre: true },
    });

    return {
      periodo: {
        desde: filtros.desdeIso,
        hasta: filtros.hastaIso,
        etiqueta: filtros.etiquetaPeriodo,
      },
      grano,
      granoAutomatico: granoPedido === undefined,
      comparadoCon: {
        desde: anterior.desdeIso,
        hasta: anterior.hastaIso,
        etiqueta: anterior.etiquetaPeriodo,
      },
      kpis,
      series,
      omitidos,
      generadoEn: getFechaUTC6().toISOString(),
      generadoPor: usuario?.nombre ?? ejecutor.email ?? 'Desconocido',
    };
  }

  /**
   * Donaciones vigentes agrupadas por el grano del panel.
   *
   * Mismo criterio que el reporte de donaciones: las anuladas no suman, porque
   * no entró ese dinero. Va en SQL crudo por lo de siempre —`groupBy` de Prisma
   * no sabe truncar una fecha— y devuelve la clave como texto para que nadie la
   * reinterprete según la zona del proceso.
   *
   * La tabla se alia como `t` porque reutiliza tal cual la expresión de
   * `DIMENSIONES_TIEMPO`, escrita contra ese alias. Escribirla aquí otra vez
   * dejaría dos definiciones de «qué es un mes» que pueden separarse, y la
   * donación de un día 31 acabaría cayendo en un mes en el panel de ventas y en
   * otro en el de donaciones.
   */
  private async donacionesEnElTiempo(
    f: FiltrosResueltos,
    grano: GranoTemporal,
  ): Promise<Array<{ clave: string; etiqueta: string; total: Prisma.Decimal }>> {
    const dimension = DIMENSIONES_TIEMPO[grano];

    const filas = await this.prisma.$queryRaw<
      Array<{ clave: string; total: Prisma.Decimal | string | number | null }>
    >`
      SELECT ${dimension.expresion}  AS clave,
             ISNULL(SUM(t.monto), 0) AS total
      FROM [dbo].[Donacion] AS t
      WHERE t.anulado = 0
        AND t.fechaCreacion >= ${f.desde}
        AND t.fechaCreacion < ${f.hasta}
      GROUP BY ${dimension.expresion}
      ORDER BY clave ASC`;

    return filas.map((fila) => ({
      clave: String(fila.clave),
      etiqueta: dimension.presentar(String(fila.clave)),
      total: aDecimal(fila.total),
    }));
  }
}
