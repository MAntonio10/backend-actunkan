import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FiltrosResueltos } from './contratos';
import { GenerarReporteDto } from './dto/generar-reporte.dto';
import {
  DIAS_SEMANA,
  METRICAS,
  Metrica,
  esAgrupacionValida,
  etiquetasDe,
  indiceDiaSemana,
} from './consultas/dimensiones';
import { textoSeguroParaMensaje } from './formato.util';
import {
  hoyNegocio,
  inicioDelMesNegocio,
  rangoNegocio,
} from './rango-negocio.util';

/**
 * Traduce los filtros que llegan del cliente o de la IA a ids y fechas.
 *
 * Es la pieza que permite que a la IA no viaje ni un dato del negocio: la IA devuelve
 * `{ vendedor: "Juan" }` en texto plano, y es este servicio —dentro del servidor, contra
 * la base— quien decide que "Juan" es el usuario 4. Nunca hizo falta mandarle la lista de
 * empleados a un tercero.
 *
 * De paso hace el sistema tolerante a los errores de dedo: quien escriba "cueva" en vez
 * de "cuevas" encuentra igual la atracción, y quien escriba algo ambiguo recibe los
 * candidatos en lugar de un reporte equivocado.
 */
@Injectable()
export class ResolutorFiltrosService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Busca un catálogo por nombre. Exacto primero, contenido después.
   *
   * @param valor Lo que escribió el usuario, o el id si el frontend ya lo conocía.
   */
  private async resolverCatalogo(
    etiqueta: string,
    valor: string,
    buscar: (texto: string) => Promise<Array<{ id: number; nombre: string }>>,
    porId: (id: number) => Promise<{ id: number; nombre: string } | null>,
  ): Promise<{ id: number; nombre: string }> {
    const texto = valor.trim();
    // Se cita saneado: devolver el texto intacto convertiria cada 422 en un reflejo
    // del payload que mandaron. Ver textoSeguroParaMensaje.
    const citable = textoSeguroParaMensaje(texto);

    // El frontend manda ids porque ya tiene los catálogos cargados; la IA manda nombres.
    if (/^\d+$/.test(texto)) {
      const encontrado = await porId(Number(texto));
      if (encontrado) return encontrado;
      throw new UnprocessableEntityException(
        `No se encontró ${etiqueta.toLowerCase()} con el identificador ${citable}.`,
      );
    }

    const candidatos = await buscar(texto);

    if (candidatos.length === 0) {
      throw new UnprocessableEntityException(
        `No se encontró ${etiqueta.toLowerCase()} que coincida con '${citable}'.`,
      );
    }

    if (candidatos.length === 1) return candidatos[0];

    // Una coincidencia exacta desempata: "Juan Pérez" no debería ser ambiguo solo porque
    // exista además "Juan Pérez López".
    const exacta = candidatos.find(
      (c) => c.nombre.toLocaleLowerCase('es') === texto.toLocaleLowerCase('es'),
    );
    if (exacta) return exacta;

    throw new UnprocessableEntityException(
      `'${citable}' coincide con varias opciones de ${etiqueta.toLowerCase()}: ` +
        // Los nombres salen de la base, pero los escribio alguien en un formulario:
        // tampoco se devuelven crudos.
        `${candidatos
          .slice(0, 8)
          .map((c) => textoSeguroParaMensaje(c.nombre))
          .join(', ')}. ` +
        'Precise cuál.',
    );
  }

  private async resolverUsuario(valor: string) {
    return this.resolverCatalogo(
      'un usuario',
      valor,
      (texto) =>
        this.prisma.usuario.findMany({
          // Se incluyen los dados de baja: un reporte de agosto tiene que poder filtrar
          // por quien ya no trabaja aquí.
          where: { nombre: { contains: texto } },
          select: { id: true, nombre: true },
          take: 10,
        }),
      (id) =>
        this.prisma.usuario.findUnique({
          where: { id },
          select: { id: true, nombre: true },
        }),
    );
  }

  private async resolverAtraccion(valor: string) {
    return this.resolverCatalogo(
      'una atracción',
      valor,
      (texto) =>
        this.prisma.atraccion.findMany({
          where: {
            anulado: false,
            OR: [
              { nombre: { contains: texto } },
              { codigo: { contains: texto } },
            ],
          },
          select: { id: true, nombre: true },
          take: 10,
        }),
      (id) =>
        this.prisma.atraccion.findUnique({
          where: { id },
          select: { id: true, nombre: true },
        }),
    );
  }

  private async resolverOrigen(valor: string) {
    return this.resolverCatalogo(
      'un origen de visitante',
      valor,
      (texto) =>
        this.prisma.origenVisitante.findMany({
          where: {
            anulado: false,
            OR: [
              { nombre: { contains: texto } },
              { codigo: { contains: texto } },
            ],
          },
          select: { id: true, nombre: true },
          take: 10,
        }),
      (id) =>
        this.prisma.origenVisitante.findUnique({
          where: { id },
          select: { id: true, nombre: true },
        }),
    );
  }

  private async resolverPais(valor: string) {
    return this.resolverCatalogo(
      'un país',
      valor,
      (texto) =>
        this.prisma.pais.findMany({
          where: {
            anulado: false,
            OR: [{ nombre: { contains: texto } }, { codigoIso: texto }],
          },
          select: { id: true, nombre: true },
          take: 10,
        }),
      (id) =>
        this.prisma.pais.findUnique({
          where: { id },
          select: { id: true, nombre: true },
        }),
    );
  }

  private async resolverGuia(valor: string) {
    return this.resolverCatalogo(
      'una guía',
      valor,
      (texto) =>
        this.prisma.guia.findMany({
          where: { anulado: false, nombre: { contains: texto } },
          select: { id: true, nombre: true },
          take: 10,
        }),
      (id) =>
        this.prisma.guia.findUnique({
          where: { id },
          select: { id: true, nombre: true },
        }),
    );
  }

  private async resolverTipoVisitante(valor: string) {
    return this.resolverCatalogo(
      'un tipo de visitante',
      valor,
      (texto) =>
        this.prisma.tipoVisitante.findMany({
          where: {
            anulado: false,
            OR: [
              { nombre: { contains: texto } },
              { codigo: { contains: texto } },
            ],
          },
          select: { id: true, nombre: true },
          take: 10,
        }),
      (id) =>
        this.prisma.tipoVisitante.findUnique({
          where: { id },
          select: { id: true, nombre: true },
        }),
    );
  }

  private async resolverTipoRecorrido(valor: string) {
    return this.resolverCatalogo(
      'un tipo de recorrido',
      valor,
      (texto) =>
        this.prisma.tipoRecorrido.findMany({
          where: {
            anulado: false,
            OR: [
              { nombre: { contains: texto } },
              { codigo: { contains: texto } },
            ],
          },
          select: { id: true, nombre: true },
          take: 10,
        }),
      (id) =>
        this.prisma.tipoRecorrido.findUnique({
          where: { id },
          select: { id: true, nombre: true },
        }),
    );
  }

  private async resolverFormaPago(valor: string) {
    return this.resolverCatalogo(
      'una forma de pago',
      valor,
      (texto) =>
        this.prisma.opcionPago.findMany({
          where: { anulado: false, nombre: { contains: texto } },
          select: { id: true, nombre: true },
          take: 10,
        }),
      (id) =>
        this.prisma.opcionPago.findUnique({
          where: { id },
          select: { id: true, nombre: true },
        }),
    );
  }

  private async resolverSector(valor: string) {
    return this.resolverCatalogo(
      'un sector del parque',
      valor,
      (texto) =>
        this.prisma.sectorParque.findMany({
          where: { anulado: false, nombre: { contains: texto } },
          select: { id: true, nombre: true },
          take: 10,
        }),
      (id) =>
        this.prisma.sectorParque.findUnique({
          where: { id },
          select: { id: true, nombre: true },
        }),
    );
  }

  /** La caja se identifica por su número de apertura, no por nombre. */
  private async resolverCaja(valor: string) {
    const texto = valor.trim();
    // Se cita saneado: devolver el texto intacto convertiria cada 422 en un reflejo
    // del payload que mandaron. Ver textoSeguroParaMensaje.
    const citable = textoSeguroParaMensaje(texto);
    if (!/^\d+$/.test(texto)) {
      throw new BadRequestException(
        `La caja se identifica por el número de su apertura; '${citable}' no es un número.`,
      );
    }
    const apertura = await this.prisma.aperturaCaja.findFirst({
      where: { id: Number(texto), anulado: false },
      select: { id: true, usuario: { select: { nombre: true } } },
    });
    if (!apertura) {
      throw new UnprocessableEntityException(
        `No se encontró una apertura de caja vigente con el número ${citable}.`,
      );
    }
    return {
      id: apertura.id,
      nombre: `#${apertura.id} (${apertura.usuario?.nombre ?? 'sin cajero'})`,
    };
  }

  /**
   * Resuelve todos los filtros de una petición.
   *
   * El período se rellena solo cuando no viene: sin esto, una instrucción como "las
   * ventas de Juan" quedaría sin rango y consultaría la tabla entera.
   */
  async resolver(dto: GenerarReporteDto): Promise<FiltrosResueltos> {
    const desdeIso = dto.desde ?? inicioDelMesNegocio();
    const hastaIso = dto.hasta ?? hoyNegocio();
    const { desde, hasta, etiqueta } = rangoNegocio(desdeIso, hastaIso);

    const aplicados: Array<{ etiqueta: string; valor: string }> = [];
    const resueltos: FiltrosResueltos = {
      desde,
      hasta,
      desdeIso,
      hastaIso,
      etiquetaPeriodo: etiqueta,
      aplicados,
    };

    // Cada entrada: [valor recibido, etiqueta legible, resolutor, campo destino].
    const pendientes: Array<
      [
        string | undefined,
        string,
        (v: string) => Promise<{ id: number; nombre: string }>,
        keyof FiltrosResueltos,
      ]
    > = [
      [dto.vendedor, 'Vendedor', (v) => this.resolverUsuario(v), 'idUsuario'],
      [
        dto.atraccion,
        'Atracción',
        (v) => this.resolverAtraccion(v),
        'idAtraccion',
      ],
      [dto.origen, 'Origen', (v) => this.resolverOrigen(v), 'idOrigen'],
      [dto.pais, 'País', (v) => this.resolverPais(v), 'idPais'],
      [dto.guia, 'Guía', (v) => this.resolverGuia(v), 'idGuia'],
      [
        dto.tipoVisitante,
        'Tipo de visitante',
        (v) => this.resolverTipoVisitante(v),
        'idTipoVisitante',
      ],
      [
        dto.tipoRecorrido,
        'Recorrido',
        (v) => this.resolverTipoRecorrido(v),
        'idTipoRecorrido',
      ],
      [
        dto.formaPago,
        'Forma de pago',
        (v) => this.resolverFormaPago(v),
        'idOpcionPago',
      ],
      [dto.caja, 'Caja', (v) => this.resolverCaja(v), 'idAperturaCaja'],
      [dto.sector, 'Sector', (v) => this.resolverSector(v), 'idSectorParque'],
    ];

    for (const [valor, etiquetaFiltro, resolutor, campo] of pendientes) {
      if (!valor) continue;
      const encontrado = await resolutor(valor);
      (resueltos as unknown as Record<string, unknown>)[campo] = encontrado.id;
      aplicados.push({ etiqueta: etiquetaFiltro, valor: encontrado.nombre });
    }

    // Módulo y acción de bitácora no son catálogos: son texto libre que se busca por
    // coincidencia parcial en la propia tabla.
    if (dto.modulo) {
      resueltos.modulo = dto.modulo.trim();
      aplicados.push({ etiqueta: 'Módulo', valor: resueltos.modulo });
    }
    if (dto.accion) {
      resueltos.accion = dto.accion.trim();
      aplicados.push({ etiqueta: 'Acción', valor: resueltos.accion });
    }
    if (dto.incluirAnulados === 'true') {
      resueltos.incluirAnulados = true;
      aplicados.push({ etiqueta: 'Incluye anulados', valor: 'Sí' });
    }

    // Reporte a medida. No son filtros —no recortan filas— sino la forma del
    // desglose, pero viajan por el mismo camino y se dejan constar igual: un
    // reporte tiene que decir por qué está agrupado como está.
    if (dto.dimension && esAgrupacionValida(dto.dimension)) {
      resueltos.dimension = dto.dimension;
      aplicados.push({
        etiqueta: 'Agrupado por',
        valor: etiquetasDe(dto.dimension).columna,
      });
    }
    if (dto.dimension2 && esAgrupacionValida(dto.dimension2)) {
      resueltos.dimension2 = dto.dimension2;
      aplicados.push({
        etiqueta: 'Cruzado con',
        valor: etiquetasDe(dto.dimension2).columna,
      });
    }
    if (dto.metrica && (METRICAS as readonly string[]).includes(dto.metrica)) {
      resueltos.metrica = dto.metrica as Metrica;
    }
    if (dto.diaSemana) {
      const indice = indiceDiaSemana(dto.diaSemana);
      if (indice !== null) {
        resueltos.diaSemana = indice;
        const nombre = DIAS_SEMANA[indice];
        aplicados.push({
          etiqueta: 'Día de la semana',
          valor: `${nombre[0].toLocaleUpperCase('es')}${nombre.slice(1)}`,
        });
      }
    }
    if (dto.tope) {
      const tope = Number(dto.tope);
      if (Number.isFinite(tope) && tope > 0) {
        resueltos.tope = tope;
        aplicados.push({ etiqueta: 'Se muestran', valor: `${tope} primeras` });
      }
    }

    return resueltos;
  }

  /**
   * Rearma la query string de la vía 1 a partir de lo que pidió el usuario.
   *
   * Es lo que permite que una petición hecha en lenguaje natural se convierta en una URL
   * normal: el frontend la guarda como favorito y volver a ejecutarla no vuelve a gastar
   * una llamada a la IA.
   */
  construirQueryString(
    dto: GenerarReporteDto,
    filtros: FiltrosResueltos,
  ): string {
    const parametros = new URLSearchParams();
    parametros.set('desde', filtros.desdeIso);
    parametros.set('hasta', filtros.hastaIso);

    // Se escriben los ids ya resueltos y no el texto original: la URL guardada tiene que
    // seguir apuntando al mismo vendedor aunque mañana entre otro con nombre parecido.
    const idPorClave: Array<[string, number | undefined]> = [
      ['vendedor', filtros.idUsuario],
      ['atraccion', filtros.idAtraccion],
      ['origen', filtros.idOrigen],
      ['pais', filtros.idPais],
      ['guia', filtros.idGuia],
      ['tipoVisitante', filtros.idTipoVisitante],
      ['tipoRecorrido', filtros.idTipoRecorrido],
      ['formaPago', filtros.idOpcionPago],
      ['caja', filtros.idAperturaCaja],
      ['sector', filtros.idSectorParque],
    ];

    for (const [clave, id] of idPorClave) {
      if (id) parametros.set(clave, String(id));
    }
    if (filtros.modulo) parametros.set('modulo', filtros.modulo);
    if (filtros.accion) parametros.set('accion', filtros.accion);
    if (dto.incluirAnulados === 'true')
      parametros.set('incluirAnulados', 'true');

    // La forma del desglose también va en la URL: si no, el PDF que se descarga
    // de una petición escrita saldría agrupado de otra manera que la tabla que
    // el usuario acaba de ver en pantalla.
    if (filtros.dimension) parametros.set('dimension', filtros.dimension);
    if (filtros.dimension2) parametros.set('dimension2', filtros.dimension2);
    if (filtros.metrica) parametros.set('metrica', filtros.metrica);
    if (filtros.tope) parametros.set('tope', String(filtros.tope));
    if (filtros.diaSemana !== undefined) {
      parametros.set('diaSemana', DIAS_SEMANA[filtros.diaSemana]);
    }

    return parametros.toString();
  }
}
