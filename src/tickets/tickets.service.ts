import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../common/utils/date.util';
import { generarCorrelativo } from '../common/utils/correlativo.util';
import { construirPayloadQr, firmarNumeroTicket, verificarFirmaTicket } from '../common/utils/qr.util';
import { GuiasService } from '../guias/guias.service';
import { RecurrenteService } from '../pagos/recurrente.service';
import { ESTADO_PAGO_PAGADO, ESTADO_PAGO_PENDIENTE } from '../pagos/pagos.service';
import { EmitirTicketDto } from './dto/emitir-ticket.dto';
import { QueryTicketDto } from './dto/query-ticket.dto';
import { ValidarTicketDto } from './dto/validar-ticket.dto';

/** Códigos de catálogo sobre los que se apoyan las reglas de negocio. */
export const ORIGEN_EXTRANJERO = 'extranjero';
export const CATEGORIA_NINO_MENOR = 'nino_menor';
export const CATEGORIA_CENTRO_EDUCATIVO = 'centro_educativo';

export const TIPO_TICKET_VISITANTE = 'VISITANTE';
export const TIPO_TICKET_GUIA = 'GUIA';

const INCLUDE_TICKET = {
  atraccion: { select: { id: true, codigo: true, nombre: true } },
  origen: { select: { id: true, codigo: true, nombre: true } },
  pais: { select: { id: true, nombre: true, codigoIso: true } },
  tipoRecorrido: { select: { id: true, codigo: true, nombre: true } },
  guia: { select: { id: true, nombre: true, tieneCarnet: true } },
  usuario: { select: { id: true, nombre: true, correo: true } },
  visitantePorTickets: { include: { tipoVisitantes: true } },
  ticketPagos: { include: { opcionPago: true } },
};

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cajasService: CajasService,
    private readonly bitacoraService: BitacoraService,
    private readonly recurrente: RecurrenteService,
  ) {}

  private async obtenerNombreEjecutor(tx: any, ejecutor?: EjecutorInfo) {
    let nombreEjecutor = ejecutor?.email;
    if (ejecutor?.id) {
      const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
      if (uEj) nombreEjecutor = uEj.nombre;
    }
    return nombreEjecutor;
  }

  /**
   * No se vende sin caja abierta: el ticket es un ingreso y debe quedar
   * asociado al arqueo del turno vigente.
   */
  private async exigirCajaAbierta(tx: any, idAperturaCaja: number) {
    const caja = await tx.aperturaCaja.findUnique({
      where: { id: idAperturaCaja },
      include: { estado: true },
    });

    if (!caja || caja.anulado || caja.estado.nombre !== 'Abierta') {
      throw new BadRequestException(
        'No hay una caja abierta para emitir el ticket. Abra la caja antes de vender.',
      );
    }

    return caja;
  }

  /**
   * Folio correlativo. El contador es numérico, pero el folio que se persiste es
   * siempre texto: la serie es alfanumérica y configurable (TICKET_SERIE).
   */
  private async generarNumeroTicket(tx: any, anio: number): Promise<string> {
    return generarCorrelativo(tx, process.env.TICKET_SERIE || 'TCK', anio);
  }

  /** Resuelve la tarifa vigente en servidor. El cliente nunca envía precios. */
  private async obtenerPrecioVigente(
    tx: any,
    idAtraccion: number,
    idOrigen: number,
    tipoVisitante: { id: number; codigo: string; nombre: string },
  ): Promise<Prisma.Decimal> {
    // El menor de 7 años siempre entra gratis, exista o no una tarifa cargada.
    if (tipoVisitante.codigo === CATEGORIA_NINO_MENOR) {
      return new Prisma.Decimal(0);
    }

    const tarifa = await tx.tarifa.findFirst({
      where: {
        idAtraccion,
        idOrigen,
        idTipoVisitante: tipoVisitante.id,
        vigenteHasta: null,
        anulado: false,
      },
    });

    if (!tarifa) {
      throw new BadRequestException(
        `No hay una tarifa vigente para '${tipoVisitante.nombre}' en esa combinación de atracción y origen.`,
      );
    }

    return new Prisma.Decimal(tarifa.precio);
  }

  /**
   * Crea el link de pago (`checkout_url`) para una forma de pago que no es efectivo.
   * Ese link es el que se copia y se envía al cliente por correo o WhatsApp.
   *
   * Si la pasarela falla, la excepción aborta la transacción y **la venta no se
   * registra**: es preferible a dejar un ticket sin forma de cobrarlo.
   */
  private async crearLinkDePago(concepto: string, monto: Prisma.Decimal) {
    const centavos = monto.mul(100).toDecimalPlaces(0).toNumber();

    const checkout = await this.recurrente.crearCheckout({
      concepto,
      montoEnCentavos: centavos,
      successUrl: process.env.RECURRENTE_SUCCESS_URL || 'http://localhost:3000/pago/exito',
      cancelUrl: process.env.RECURRENTE_CANCEL_URL || 'http://localhost:3000/pago/cancelado',
    });

    return { idPagoPasarela: checkout.id, checkoutUrl: checkout.checkout_url };
  }

  /**
   * Datos de pago según la forma elegida:
   * el efectivo se cobra en el acto; la tarjeta genera un link y queda pendiente
   * hasta que la pasarela confirme.
   */
  private async prepararPago(opcionPago: any, monto: Prisma.Decimal, concepto: string) {
    if (opcionPago.esEfectivo) {
      return { estadoPago: ESTADO_PAGO_PAGADO, fechaPago: getFechaUTC6() };
    }

    const { idPagoPasarela, checkoutUrl } = await this.crearLinkDePago(concepto, monto);
    return { estadoPago: ESTADO_PAGO_PENDIENTE, idPagoPasarela, checkoutUrl };
  }

  private async resolverGuia(tx: any, dto: EmitirTicketDto, ahora: Date) {
    const guiaDto = dto.guia;
    if (!guiaDto) return null;

    if (guiaDto.modo === 'existente') {
      if (!guiaDto.idGuia) {
        throw new BadRequestException('Debe indicar el guía cuando el modo es "existente".');
      }

      const guia = await tx.guia.findUnique({ where: { id: guiaDto.idGuia } });
      if (!guia || guia.anulado) {
        throw new BadRequestException(
          `El guía con ID ${guiaDto.idGuia} no existe o se encuentra anulado.`,
        );
      }
      return guia;
    }

    if (!guiaDto.nombre) {
      throw new BadRequestException('Debe indicar el nombre del guía cuando el modo es "nuevo".');
    }

    if (guiaDto.tieneCarnet === true && !guiaDto.numeroCarnet) {
      throw new BadRequestException('Debe indicar el número de carnet cuando el guía tiene carnet.');
    }

    // Sin esta verificación, escribir dos veces el mismo nombre creaba dos guías y
    // el selector terminaba lleno de repetidos.
    await GuiasService.exigirNombreLibre(tx, guiaDto.nombre);

    // El guía nuevo queda registrado en el catálogo para futuras emisiones.
    return tx.guia.create({
      data: {
        nombre: guiaDto.nombre,
        tieneCarnet: guiaDto.tieneCarnet ?? false,
        numeroCarnet: guiaDto.tieneCarnet ? guiaDto.numeroCarnet : null,
        fechaCreacion: ahora,
        fechaActualizacion: ahora,
      },
    });
  }

  /**
   * Todo lo que el formulario de emisión necesita para armarse, en una sola llamada.
   * Son datos de configuración: se consultan al abrir el formulario y alimentan
   * el `POST /tickets/emitir`. Por eso no tienen CRUD propio.
   */
  async obtenerCatalogos() {
    const [
      atracciones,
      origenes,
      paises,
      tiposVisitante,
      tiposRecorrido,
      opcionesPago,
      guias,
      tarifas,
      tarifaGuia,
    ] = await Promise.all([
      this.prisma.atraccion.findMany({
        where: { anulado: false },
        select: { id: true, codigo: true, nombre: true },
        orderBy: { nombre: 'asc' },
      }),
      this.prisma.origenVisitante.findMany({
        where: { anulado: false },
        select: { id: true, codigo: true, nombre: true },
        orderBy: { nombre: 'asc' },
      }),
      this.prisma.pais.findMany({
        where: { anulado: false },
        select: { id: true, nombre: true, codigoIso: true },
        orderBy: { nombre: 'asc' },
      }),
      this.prisma.tipoVisitante.findMany({
        where: { anulado: false },
        select: { id: true, codigo: true, nombre: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.tipoRecorrido.findMany({
        where: { anulado: false },
        select: { id: true, codigo: true, nombre: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.opcionPago.findMany({
        where: { anulado: false },
        select: { id: true, nombre: true, esEfectivo: true },
        orderBy: { nombre: 'asc' },
      }),
      this.prisma.guia.findMany({
        where: { anulado: false },
        select: { id: true, nombre: true, tieneCarnet: true },
        orderBy: { nombre: 'asc' },
      }),
      this.prisma.tarifa.findMany({
        where: { vigenteHasta: null, anulado: false },
        select: {
          idAtraccion: true,
          idOrigen: true,
          idTipoVisitante: true,
          precio: true,
        },
      }),
      this.prisma.tarifaGuia.findFirst({
        where: { vigenteHasta: null },
        select: { precio: true },
      }),
    ]);

    return {
      atracciones,
      origenes,
      paises,
      tiposVisitante,
      tiposRecorrido,
      opcionesPago,
      guias,
      // Precios vigentes por combinación; el servidor los vuelve a resolver al
      // emitir, así que esto es solo para que el formulario muestre el total.
      tarifas,
      precioTicketGuia: tarifaGuia ? tarifaGuia.precio : null,
    };
  }

  /**
   * Agrega el QR codificado y el estado de pago del ticket para el frontend.
   * Si tiene pagos pendientes de confirmación, se envía como 'Pago pendiente'.
   */
  private formatearTicket(ticket: any) {
    let pagos: any[] = [];
    if (Array.isArray(ticket.ticketPagos)) {
      pagos = ticket.ticketPagos;
    } else if (ticket.ticketPagos?.create) {
      pagos = Array.isArray(ticket.ticketPagos.create)
        ? ticket.ticketPagos.create
        : [ticket.ticketPagos.create];
    } else if (ticket.ticketPagos && typeof ticket.ticketPagos === 'object') {
      pagos = [ticket.ticketPagos];
    }

    const tienePendiente =
      ticket.estadoPago === ESTADO_PAGO_PENDIENTE ||
      ticket.estadoPago === 'Pago pendiente' ||
      pagos.some(
        (p: any) =>
          !p.anulado && (p.estadoPago === ESTADO_PAGO_PENDIENTE || p.estadoPago === 'Pago pendiente'),
      );

    const estadoPago = ticket.anulado
      ? 'CANCELADO'
      : tienePendiente
      ? 'Pago pendiente'
      : 'PAGADO';

    return {
      ...ticket,
      estadoPago,
      qr: construirPayloadQr(ticket.numeroTicket, ticket.qrFirma),
    };
  }

  async emitir(dto: EmitirTicketDto, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException('No se pudo determinar el usuario que emite el ticket.');
    }

    const cajaActual = await this.cajasService.obtenerActual();
    if (!cajaActual) {
      throw new BadRequestException(
        'No hay una caja abierta para emitir el ticket. Abra la caja antes de vender.',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        // La caja pudo cerrarse entre la consulta anterior y esta transacción.
        await this.exigirCajaAbierta(tx, cajaActual.id);

        const [atraccion, origen, tipoRecorrido, opcionPago] = await Promise.all([
          tx.atraccion.findUnique({ where: { id: dto.idAtraccion } }),
          tx.origenVisitante.findUnique({ where: { id: dto.idOrigen } }),
          tx.tipoRecorrido.findUnique({ where: { id: dto.idTipoRecorrido } }),
          tx.opcionPago.findUnique({ where: { id: dto.idOpcionPago } }),
        ]);

        if (!atraccion || atraccion.anulado) {
          throw new BadRequestException('La atracción indicada no existe o está anulada.');
        }
        if (!origen || origen.anulado) {
          throw new BadRequestException('El origen de visitante indicado no existe o está anulado.');
        }
        if (!tipoRecorrido || tipoRecorrido.anulado) {
          throw new BadRequestException('El tipo de recorrido indicado no existe o está anulado.');
        }
        if (!opcionPago || opcionPago.anulado) {
          throw new BadRequestException('La forma de pago indicada no existe o está anulada.');
        }

        const esExtranjero = origen.codigo === ORIGEN_EXTRANJERO;
        let idPais: number | null = null;

        if (esExtranjero) {
          if (!dto.idPais) {
            throw new BadRequestException(
              'Debe indicar el país de origen cuando el visitante es extranjero.',
            );
          }
          const pais = await tx.pais.findUnique({ where: { id: dto.idPais } });
          if (!pais || pais.anulado) {
            throw new BadRequestException(`El país con ID ${dto.idPais} no existe o está anulado.`);
          }
          idPais = pais.id;
        }

        // Solo interesan las categorías con cantidad real.
        const cantidades = dto.cantidades.filter((c) => c.cantidad > 0);
        const totalPersonas = cantidades.reduce((suma, c) => suma + c.cantidad, 0);

        if (totalPersonas < 1) {
          throw new BadRequestException('Debe registrar al menos una persona en el ticket.');
        }

        const detalles: Array<{
          idTipoVisitante: number;
          cantidad: number;
          precioUnitario: Prisma.Decimal;
          subtotal: Prisma.Decimal;
        }> = [];
        let montoVisitantes = new Prisma.Decimal(0);

        for (const item of cantidades) {
          const tipoVisitante = await tx.tipoVisitante.findUnique({
            where: { id: item.idTipoVisitante },
          });

          if (!tipoVisitante || tipoVisitante.anulado) {
            throw new BadRequestException(
              `El tipo de visitante con ID ${item.idTipoVisitante} no existe o está anulado.`,
            );
          }

          if (esExtranjero && tipoVisitante.codigo === CATEGORIA_CENTRO_EDUCATIVO) {
            throw new BadRequestException(
              'La categoría de centro educativo no está disponible para visitantes extranjeros.',
            );
          }

          const precioUnitario = await this.obtenerPrecioVigente(
            tx,
            atraccion.id,
            origen.id,
            tipoVisitante,
          );
          const subtotal = precioUnitario.mul(item.cantidad);

          detalles.push({
            idTipoVisitante: tipoVisitante.id,
            cantidad: item.cantidad,
            precioUnitario,
            subtotal,
          });
          montoVisitantes = montoVisitantes.plus(subtotal);
        }

        const ahora = getFechaUTC6();
        const anio = ahora.getFullYear();
        const guia = await this.resolverGuia(tx, dto, ahora);

        // Con tarjeta esto llama a la pasarela desde dentro de la transacción.
        // Se acepta porque el efectivo —la mayoría de las ventas— nunca pasa por aquí,
        // y la llamada tiene un tope de 15 s.
        const pagoVisitante = await this.prepararPago(
          opcionPago,
          montoVisitantes,
          `Ingreso ${atraccion.nombre} - ${dto.nombreGrupo}`,
        );

        const grupo = await tx.grupoEmision.create({
          data: {
            idUsuario: ejecutor.id,
            idAperturaCaja: cajaActual.id,
            fechaCreacion: ahora,
          },
        });

        const datosComunes = {
          idGrupoEmision: grupo.id,
          idTipoRecorrido: tipoRecorrido.id,
          idAperturaCaja: cajaActual.id,
          idUsuario: ejecutor.id,
          idAtraccion: atraccion.id,
          idOrigen: origen.id,
          idPais,
          idGuia: guia?.id ?? null,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        };

        // --- Ticket del visitante ---
        const numeroVisitante = await this.generarNumeroTicket(tx, anio);
        const ticketVisitante = await tx.ticket.create({
          data: {
            ...datosComunes,
            numeroTicket: numeroVisitante,
            tipoTicket: TIPO_TICKET_VISITANTE,
            nombre: dto.nombreGrupo,
            cantidadPersonas: totalPersonas,
            montoTotal: montoVisitantes,
            observaciones: dto.notas,
            qrFirma: firmarNumeroTicket(numeroVisitante),
            visitantePorTickets: { create: detalles },
            ticketPagos: {
              create: {
                idOpcionPago: opcionPago.id,
                monto: montoVisitantes,
                ...pagoVisitante,
                fechaCreacion: ahora,
                fechaActualizacion: ahora,
              },
            },
          },
          include: INCLUDE_TICKET,
        });

        const tickets = [ticketVisitante];

        // --- Ticket independiente del guía sin carnet ---
        if (guia && !guia.tieneCarnet) {
          const tarifaGuia = await tx.tarifaGuia.findFirst({ where: { vigenteHasta: null } });

          if (!tarifaGuia) {
            throw new BadRequestException(
              'No hay una tarifa vigente para el ticket de guía. Configure el catálogo de tarifas.',
            );
          }

          const opcionPagoGuia = dto.guia?.idOpcionPagoGuia
            ? await tx.opcionPago.findUnique({ where: { id: dto.guia.idOpcionPagoGuia } })
            : opcionPago;

          if (!opcionPagoGuia || opcionPagoGuia.anulado) {
            throw new BadRequestException(
              'La forma de pago del ticket de guía no existe o está anulada.',
            );
          }

          const montoGuia = new Prisma.Decimal(tarifaGuia.precio);
          const numeroGuia = await this.generarNumeroTicket(tx, anio);

          const ticketGuia = await tx.ticket.create({
            data: {
              ...datosComunes,
              numeroTicket: numeroGuia,
              tipoTicket: TIPO_TICKET_GUIA,
              nombre: guia.nombre,
              cantidadPersonas: 1,
              montoTotal: montoGuia,
              observaciones: `Ticket de guía sin carnet asociado al grupo '${dto.nombreGrupo}'.`,
              qrFirma: firmarNumeroTicket(numeroGuia),
              ticketPagos: {
                create: {
                  idOpcionPago: opcionPagoGuia.id,
                  monto: montoGuia,
                  ...(await this.prepararPago(opcionPagoGuia, montoGuia, `Ticket de guía ${guia.nombre}`)),
                  fechaCreacion: ahora,
                  fechaActualizacion: ahora,
                },
              },
            },
            include: INCLUDE_TICKET,
          });

          tickets.push(ticketGuia);
        }

        const montoTotalGeneral = tickets.reduce(
          (suma, t) => suma.plus(new Prisma.Decimal(t.montoTotal)),
          new Prisma.Decimal(0),
        );

        await BitacoraService.registrarEnTransaccion(tx, {
          idUsuario: ejecutor.id,
          usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
          accion: 'EMITIR_TICKET',
          modulo: 'Tickets',
          descripcion:
            `Se emitieron ${tickets.length} ticket(s) [${tickets.map((t) => t.numeroTicket).join(', ')}] ` +
            `para '${dto.nombreGrupo}' en '${atraccion.nombre}' (${origen.nombre}), ` +
            `${totalPersonas} persona(s), total ${montoTotalGeneral.toString()}.`,
        });

        return {
          idGrupoEmision: grupo.id,
          montoVisitantes: montoVisitantes.toString(),
          montoGuia: tickets.length > 1 ? tickets[1].montoTotal.toString() : null,
          montoTotalGeneral: montoTotalGeneral.toString(),
          tickets: tickets.map((t) => this.formatearTicket(t)),
        };
      },
      // Serializable: el correlativo y la unicidad del folio dependen de que dos
      // emisiones concurrentes no lean el mismo último número.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async findAll(query: QueryTicketDto) {
    const {
      buscar,
      idAtraccion,
      idOpcionPago,
      idOrigen,
      idPais,
      fechaInicio,
      fechaFin,
      incluirAnulados,
    } = query || {};

    const pagina = query?.pagina && query.pagina > 0 ? query.pagina : 1;
    const limite = query?.limite && query.limite > 0 ? query.limite : 50;

    const where: any = {};

    if (incluirAnulados !== 'true') where.anulado = false;
    if (idAtraccion) where.idAtraccion = idAtraccion;
    if (idOrigen) where.idOrigen = idOrigen;
    if (idPais) where.idPais = idPais;
    if (idOpcionPago) where.ticketPagos = { some: { idOpcionPago, anulado: false } };

    if (fechaInicio || fechaFin) {
      where.fechaCreacion = {};
      if (fechaInicio) where.fechaCreacion.gte = new Date(fechaInicio);
      if (fechaFin) where.fechaCreacion.lte = new Date(fechaFin);
    }

    if (buscar) {
      where.OR = [
        { nombre: { contains: buscar } },
        { numeroTicket: { contains: buscar } },
        { guia: { nombre: { contains: buscar } } },
      ];
    }

    // Las métricas se agregan en el servidor: el cliente no debe traerse el dataset
    // completo solo para sumar.
    const [datos, total, agregados] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        include: INCLUDE_TICKET,
        // El folio es texto: su orden alfabético no es el cronológico.
        orderBy: { fechaCreacion: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
      }),
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.aggregate({
        where,
        _sum: { montoTotal: true, cantidadPersonas: true },
      }),
    ]);

    return {
      datos: datos.map((t) => this.formatearTicket(t)),
      total,
      pagina,
      limite,
      metricas: {
        totalTickets: total,
        totalPersonas: agregados._sum.cantidadPersonas ?? 0,
        montoRecaudado: (agregados._sum.montoTotal ?? new Prisma.Decimal(0)).toString(),
      },
    };
  }

  async findOne(id: number) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: INCLUDE_TICKET,
    });

    if (!ticket) {
      throw new NotFoundException(`No se encontró el ticket con el ID ${id}.`);
    }

    return this.formatearTicket(ticket);
  }

  async anular(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUnique({ where: { id } });

      if (!ticket) {
        throw new NotFoundException(`No se encontró el ticket con el ID ${id}.`);
      }

      if (ticket.anulado) {
        throw new BadRequestException(`El ticket ${ticket.numeroTicket} ya se encuentra anulado.`);
      }

      await this.exigirCajaAbierta(tx, ticket.idAperturaCaja);

      const ahora = getFechaUTC6();
      const anulado = await tx.ticket.update({
        where: { id },
        data: { anulado: true, fechaActualizacion: ahora },
        include: INCLUDE_TICKET,
      });

      // Los pagos también se anulan: si no, el arqueo seguiría contando el ingreso.
      await tx.ticketPago.updateMany({
        where: { idTicket: id, anulado: false },
        data: { anulado: true, fechaActualizacion: ahora },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ANULAR_TICKET',
        modulo: 'Tickets',
        descripcion: `Se anuló el ticket ${anulado.numeroTicket} y sus pagos asociados.`,
      });

      return this.formatearTicket(anulado);
    });
  }

  /**
   * Control de acceso en taquilla. Verifica la firma del QR y sella el primer uso;
   * cualquier intento posterior se rechaza y queda registrado en bitácora.
   */
  async validar(dto: ValidarTicketDto, ejecutor?: EjecutorInfo) {
    const registrarIntento = async (resultado: string) => {
      await this.bitacoraService.registrar({
        idUsuario: ejecutor?.id,
        usuarioNombre: ejecutor?.email,
        accion: 'VALIDAR_TICKET',
        modulo: 'Tickets',
        descripcion: `Validación del ticket ${dto.numeroTicket}: ${resultado}.`,
      });
    };

    if (!verificarFirmaTicket(dto.numeroTicket, dto.firma)) {
      await registrarIntento('RECHAZADO - firma del QR inválida');
      throw new UnauthorizedException('El código QR no es válido o fue alterado.');
    }

    const ticket = await this.prisma.ticket.findUnique({
      where: { numeroTicket: dto.numeroTicket },
      include: INCLUDE_TICKET,
    });

    if (!ticket) {
      await registrarIntento('RECHAZADO - ticket inexistente');
      throw new NotFoundException(`No existe el ticket ${dto.numeroTicket}.`);
    }

    if (ticket.anulado) {
      await registrarIntento('RECHAZADO - ticket anulado');
      throw new ConflictException(`El ticket ${dto.numeroTicket} está anulado.`);
    }

    if (ticket.fechaUso) {
      await registrarIntento(`RECHAZADO - ya utilizado el ${ticket.fechaUso.toISOString()}`);
      throw new ConflictException(
        `El ticket ${dto.numeroTicket} ya fue utilizado el ${ticket.fechaUso.toISOString()}.`,
      );
    }

    // El ticket se emite junto con el link de pago, así que su QR existe antes de
    // que la tarjeta se cobre. Sin esta verificación, bastaría generar un link y
    // presentarse en la entrada sin pagar.
    const pendiente = ticket.ticketPagos?.find(
      (p: any) => !p.anulado && (p.estadoPago === ESTADO_PAGO_PENDIENTE || p.estadoPago === 'Pago pendiente'),
    );

    if (pendiente) {
      await registrarIntento('RECHAZADO - pago pendiente de confirmación');
      throw new ConflictException(
        `El ticket ${dto.numeroTicket} tiene un pago pendiente de confirmación. ` +
          'No se permite el ingreso hasta que la pasarela confirme el cobro.',
      );
    }

    const usado = await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: { fechaUso: getFechaUTC6(), idUsuarioUso: ejecutor?.id ?? null },
      include: INCLUDE_TICKET,
    });

    await registrarIntento('ACEPTADO - ingreso autorizado');

    return { valido: true, mensaje: 'Ingreso autorizado.', ticket: this.formatearTicket(usado) };
  }
}
