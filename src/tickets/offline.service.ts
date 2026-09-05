import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../common/utils/date.util';
import { generarCorrelativo } from '../common/utils/correlativo.util';
import { construirPayloadQr, firmarNumeroTicket } from '../common/utils/qr.util';
import { resolverTarifaGuiaEn } from '../tarifas/resolver-tarifa.util';
import { ESTADO_PAGO_PAGADO } from '../pagos/pagos.service';
import {
  TicketsService,
  TIPO_TICKET_GUIA,
  TIPO_TICKET_VISITANTE,
} from './tickets.service';
import { conciliarLotesVencidos } from './conciliar-vencidos.util';
import { ConciliarLoteDto, CrearLoteOfflineDto } from './dto/lote-offline.dto';
import { EmitirOfflineDto, VentaOfflineDto } from './dto/emitir-offline.dto';

export const LOTE_ACTIVO = 'ACTIVO';
export const LOTE_CONCILIADO = 'CONCILIADO';
export const LOTE_INVALIDADO = 'INVALIDADO';

export const FOLIO_RESERVADO = 'RESERVADO';
export const FOLIO_EMITIDO = 'EMITIDO';
export const FOLIO_NO_UTILIZADO = 'NO_UTILIZADO';
export const FOLIO_INVALIDADO = 'INVALIDADO';

/** Hora a la que vence la jornada operativa; configurable. */
const HORA_EXPIRACION = Number(process.env.OFFLINE_EXPIRA_HORA ?? 6);

const MODULO_BITACORA = 'Tickets';

/**
 * Venta de tickets sin conexión.
 *
 * El servidor entrega **folios pre-firmados** mientras hay red; el dispositivo los
 * consume después, sin ella, y entrega un pase con QR válido desde el momento de la
 * venta. Al reconectar sube la cola y cada folio se convierte en un ticket real.
 *
 * Ver `ESPECIFICACION_OFFLINE.md` para el diseño completo.
 */
@Injectable()
export class OfflineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cajasService: CajasService,
    private readonly ticketsService: TicketsService,
  ) {}

  private async obtenerNombreEjecutor(tx: any, ejecutor?: EjecutorInfo) {
    let nombreEjecutor = ejecutor?.email;
    if (ejecutor?.id) {
      const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
      if (uEj) nombreEjecutor = uEj.nombre;
    }
    return nombreEjecutor;
  }

  /** Fin de la jornada: las 06:00 del día siguiente, en el reloj de la base. */
  private calcularExpiracion(desde: Date): Date {
    const expira = new Date(desde);
    expira.setDate(expira.getDate() + 1);
    expira.setHours(HORA_EXPIRACION, 0, 0, 0);
    return expira;
  }

  private folioConQr(folio: any) {
    return {
      numeroTicket: folio.numeroTicket,
      firma: folio.firma,
      // Lo arma el servidor con la misma función que la emisión online: si el
      // frontend reprodujera el formato, un cambio futuro rompería los pases
      // offline y el problema aparecería recién en la puerta de la cueva.
      qr: construirPayloadQr(folio.numeroTicket, folio.firma),
    };
  }

  private formatearLote(lote: any) {
    const folios = (lote.folios ?? []).filter((f: any) => f.estado === FOLIO_RESERVADO);

    return {
      idLote: lote.id,
      idAperturaCaja: lote.idAperturaCaja,
      idUsuario: lote.idUsuario,
      idDispositivo: lote.idDispositivo,
      estado: lote.estado,
      fechaCreacion: lote.fechaCreacion,
      expiraEn: lote.expiraEn,
      fechaConciliacion: lote.fechaConciliacion,
      expirado: lote.expiraEn <= getFechaUTC6(),
      folios: folios.map((f: any) => this.folioConQr(f)),
    };
  }

  // -------------------------------------------------------------------------
  // 1. Reservar folios
  // -------------------------------------------------------------------------

  async reservar(dto: CrearLoteOfflineDto, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException('No se pudo determinar el usuario que reserva los folios.');
    }

    const cajaActual = await this.cajasService.obtenerActual();
    if (!cajaActual) {
      throw new BadRequestException(
        'No hay una caja abierta para reservar folios. Abra la caja antes de vender.',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const caja = await tx.aperturaCaja.findUnique({
          where: { id: cajaActual.id },
          include: { estado: true },
        });

        if (!caja || caja.anulado || caja.estado.nombre !== 'Abierta') {
          throw new BadRequestException(
            'No hay una caja abierta para reservar folios. Abra la caja antes de vender.',
          );
        }

        const ahora = getFechaUTC6();

        // Los lotes vencidos de este dispositivo se cierran solos al reservar el
        // del día siguiente. Si no, quedarían en ACTIVO para siempre y bloquearían
        // el cierre de su caja: el frontend no puede conciliarlos porque su lote
        // "actual" ya es otro, y el viejo puede ni estar en el dispositivo.
        const vencidos = await tx.loteOffline.findMany({
          where: {
            idDispositivo: dto.idDispositivo,
            estado: LOTE_ACTIVO,
            expiraEn: { lte: ahora },
          },
        });

        if (vencidos.length > 0) {
          await conciliarLotesVencidos(tx, vencidos, {
            idUsuario: ejecutor.id,
            usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
            motivo: `reserva de un lote nuevo para el dispositivo ${dto.idDispositivo}`,
          });
        }

        const activo = await tx.loteOffline.findFirst({
          where: {
            idDispositivo: dto.idDispositivo,
            estado: LOTE_ACTIVO,
            expiraEn: { gt: ahora },
          },
        });

        if (activo) {
          throw new ConflictException({
            codigo: 'LOTE_ACTIVO_EXISTENTE',
            idLote: activo.id,
            message:
              `El dispositivo ya tiene el lote ${activo.id} activo. ` +
              'Concílielo antes de reservar otro, o recupérelo con GET /tickets/lotes-offline/activo.',
          });
        }

        const lote = await tx.loteOffline.create({
          data: {
            idUsuario: ejecutor.id,
            idAperturaCaja: caja.id,
            idDispositivo: dto.idDispositivo,
            estado: LOTE_ACTIVO,
            fechaCreacion: ahora,
            expiraEn: this.calcularExpiracion(ahora),
          },
        });

        const anio = new Date().getFullYear();
        const folios: any[] = [];

        for (let i = 0; i < dto.cantidad; i++) {
          // El mismo contador que usa la emisión online: es lo que garantiza que
          // un folio reservado nunca choque con una venta hecha mientras tanto.
          const numeroTicket = await generarCorrelativo(
            tx,
            process.env.TICKET_SERIE || 'TCK',
            anio,
          );

          folios.push(
            await tx.folioReservado.create({
              data: {
                idLote: lote.id,
                numeroTicket,
                firma: firmarNumeroTicket(numeroTicket),
                estado: FOLIO_RESERVADO,
              },
            }),
          );
        }

        await BitacoraService.registrarEnTransaccion(tx, {
          idUsuario: ejecutor.id,
          usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
          accion: 'RESERVAR_FOLIOS_OFFLINE',
          modulo: MODULO_BITACORA,
          descripcion:
            `Se reservaron ${folios.length} folios (${folios[0].numeroTicket} a ` +
            `${folios[folios.length - 1].numeroTicket}) en el lote ${lote.id} ` +
            `para el dispositivo ${dto.idDispositivo}, caja ${caja.id}.`,
        });

        return this.formatearLote({ ...lote, folios });
      },
      // Serializable: el correlativo depende de que dos reservas concurrentes
      // no lean el mismo último número.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 },
    );
  }

  // -------------------------------------------------------------------------
  // 2. Recuperar el lote activo
  // -------------------------------------------------------------------------

  /**
   * Para cuando se reinstala la aplicación o se borra el almacenamiento local.
   * Exige que coincidan usuario y dispositivo: vuelve a exponer folios
   * pre-firmados, y no debe poder usarse desde otra sesión para extraerlos.
   */
  async obtenerActivo(idDispositivo: string, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException('No se pudo determinar el usuario.');
    }

    const lote = await this.prisma.loteOffline.findFirst({
      where: {
        idDispositivo,
        idUsuario: ejecutor.id,
        estado: LOTE_ACTIVO,
      },
      include: { folios: { orderBy: { id: 'asc' } } },
      orderBy: { id: 'desc' },
    });

    if (!lote) {
      return { hayLoteActivo: false, lote: null };
    }

    return { hayLoteActivo: true, lote: this.formatearLote(lote) };
  }

  // -------------------------------------------------------------------------
  // 3. Subir la cola de ventas
  // -------------------------------------------------------------------------

  async emitirOffline(dto: EmitirOfflineDto, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException('No se pudo determinar el usuario que sube las ventas.');
    }

    const lote = await this.prisma.loteOffline.findUnique({ where: { id: dto.idLote } });

    if (!lote) {
      throw new NotFoundException(`No se encontró el lote offline con el ID ${dto.idLote}.`);
    }

    if (lote.idUsuario !== ejecutor.id) {
      throw new BadRequestException('El lote pertenece a otro usuario.');
    }

    const resultados: any[] = [];

    // Cada venta en su propia transacción: una con datos malos no debe abortar
    // las otras 49, que corresponden a dinero ya cobrado.
    for (const venta of dto.ventas) {
      try {
        resultados.push(await this.procesarVenta(lote, venta, ejecutor));
      } catch (error: any) {
        resultados.push({
          idLocal: venta.idLocal,
          estado: 'RECHAZADO',
          codigo: error?.codigoOffline ?? 'CATALOGO_INVALIDO',
          mensaje: error?.message ?? 'No se pudo registrar la venta.',
        });
      }
    }

    return {
      procesadas: resultados.filter((r) => r.estado === 'CREADO').length,
      resultados,
    };
  }

  /** Marca un error con su código de rechazo para la respuesta por ítem. */
  private rechazo(codigo: string, mensaje: string) {
    const error: any = new BadRequestException(mensaje);
    error.codigoOffline = codigo;
    return error;
  }

  private async procesarVenta(lote: any, venta: VentaOfflineDto, ejecutor: EjecutorInfo) {
    // 1. Idempotencia: si ya se registró, no crear nada.
    const existente = await this.prisma.ticket.findFirst({
      where: { idLocal: venta.idLocal },
    });

    if (existente) {
      return {
        idLocal: venta.idLocal,
        estado: 'DUPLICADO_IGNORADO',
        ticket: await this.ticketsService.findOne(existente.id),
      };
    }

    if (lote.estado === LOTE_INVALIDADO) {
      throw this.rechazo(
        'LOTE_INVALIDADO',
        `El lote ${lote.id} fue invalidado; sus folios ya no pueden emitirse.`,
      );
    }

    // 4. La fecha viene del reloj del dispositivo y no es confiable: se acota al
    //    rango de vida del lote. Un reloj mal puesto mandaría la venta al arqueo
    //    de otro día, o la haría recalcular con una tarifa que no regía.
    const fechaEmision = this.acotarFecha(new Date(venta.fechaEmision), lote);

    return this.prisma.$transaction(
      async (tx) => {
        const folioVisitante = await this.tomarFolio(tx, lote, venta.numeroTicket);
        const folioGuia = venta.numeroTicketGuia
          ? await this.tomarFolio(tx, lote, venta.numeroTicketGuia)
          : null;

        const { atraccion, origen, tipoRecorrido, opcionPago, idPais, detalles, totalPersonas } =
          await this.ticketsService.prepararEmision(tx, venta, fechaEmision);

        // 3. Sin pasarela no hay cobro con tarjeta: offline solo se vende en efectivo.
        if (!opcionPago.esEfectivo) {
          throw this.rechazo(
            'PAGO_NO_EFECTIVO',
            `La forma de pago '${opcionPago.nombre}' no es efectivo. Las ventas offline solo aceptan efectivo.`,
          );
        }

        const guia = await this.ticketsService.resolverGuia(
          tx,
          venta,
          getFechaUTC6(),
          // El mismo guía nuevo puede acompañar a varios grupos del turno: la
          // primera venta lo crea y las demás lo reutilizan, en vez de perderse.
          true,
        );

        /**
         * `montoCobrado` es el **total de la venta**, y una venta con guía sin
         * carnet emite dos tickets. Hay que repartirlo entre ellos: el guía se
         * lleva su tarifa y el resto es del visitante.
         *
         * Asignarle el total al ticket del visitante y además crear el del guía
         * por su tarifa haría que el arqueo contara el dinero del guía dos veces
         * (35 + 15 = 50 cuando al cajón entraron 35), y el cajero aparecería con
         * un faltante que no existe.
         *
         * El reparto conserva el total: `cobradoVisitante + cobradoGuia` siempre
         * es exactamente `montoCobrado`, que es lo que hay en el cajón.
         */
        const montoCobrado = new Prisma.Decimal(venta.montoCobrado);
        const montoVisitantesRecalculado = detalles.reduce(
          (suma: Prisma.Decimal, d: any) => suma.plus(d.subtotal),
          new Prisma.Decimal(0),
        );

        let tarifaGuia: any = null;
        let montoGuia = new Prisma.Decimal(0);

        if (folioGuia) {
          if (!guia) {
            throw this.rechazo(
              'CATALOGO_INVALIDO',
              'Se envió un folio de guía pero la venta no lleva guía.',
            );
          }

          tarifaGuia = await resolverTarifaGuiaEn(tx, fechaEmision);
          if (!tarifaGuia) {
            throw this.rechazo(
              'CATALOGO_INVALIDO',
              'No había una tarifa de guía vigente en la fecha de la venta.',
            );
          }

          montoGuia = new Prisma.Decimal(tarifaGuia.precio);
        }

        // Si se cobró menos que la tarifa del guía, el faltante se refleja ahí y el
        // ticket del visitante queda en 0, nunca en negativo.
        const cobradoGuia = montoGuia.greaterThan(montoCobrado) ? montoCobrado : montoGuia;
        const cobradoVisitante = montoCobrado.minus(cobradoGuia);

        // La discrepancia se juzga sobre el total de la venta, no ticket por ticket.
        const esperadoTotal = montoVisitantesRecalculado.plus(montoGuia);
        const hayDiscrepancia = !esperadoTotal.equals(montoCobrado);

        const ahora = getFechaUTC6();

        const grupo = await tx.grupoEmision.create({
          data: {
            idUsuario: ejecutor.id,
            // 7. La venta ocurrió en el turno del lote y ahí tiene que cuadrar,
            //    no en la caja que esté abierta al momento de subirla.
            idAperturaCaja: lote.idAperturaCaja,
            fechaCreacion: ahora,
          },
        });

        const datosComunes = {
          idGrupoEmision: grupo.id,
          idTipoRecorrido: tipoRecorrido.id,
          idAperturaCaja: lote.idAperturaCaja,
          idUsuario: ejecutor.id,
          idAtraccion: atraccion.id,
          idOrigen: origen.id,
          idPais,
          idGuia: guia?.id ?? null,
          idLoteOffline: lote.id,
          fechaEmisionOffline: getFechaUTC6(fechaEmision),
          origenOffline: true,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        };

        const ticketVisitante = await tx.ticket.create({
          data: {
            ...datosComunes,
            idLocal: venta.idLocal,
            numeroTicket: folioVisitante.numeroTicket,
            tipoTicket: TIPO_TICKET_VISITANTE,
            nombre: venta.nombreGrupo,
            cantidadPersonas: totalPersonas,
            montoTotal: cobradoVisitante,
            // 8. Solo se guarda cuando difiere: es la señal de un cobro mal hecho.
            montoRecalculado: hayDiscrepancia ? montoVisitantesRecalculado : null,
            observaciones: venta.notas,
            qrFirma: folioVisitante.firma,
            visitantePorTickets: { create: detalles },
            ticketPagos: {
              create: {
                idOpcionPago: opcionPago.id,
                monto: cobradoVisitante,
                estadoPago: ESTADO_PAGO_PAGADO,
                fechaPago: getFechaUTC6(fechaEmision),
                fechaCreacion: ahora,
                fechaActualizacion: ahora,
              },
            },
          },
        });

        await this.marcarEmitido(tx, folioVisitante.id, ticketVisitante.id);
        const tickets = [ticketVisitante];

        if (folioGuia) {
          const ticketGuia = await tx.ticket.create({
            data: {
              ...datosComunes,
              // El idLocal identifica la venta, y va en el ticket del visitante.
              // Repetirlo acá chocaría con el índice único.
              numeroTicket: folioGuia.numeroTicket,
              tipoTicket: TIPO_TICKET_GUIA,
              nombre: guia.nombre,
              cantidadPersonas: 1,
              montoTotal: cobradoGuia,
              // Solo difiere si se cobró menos que la tarifa del guía.
              montoRecalculado: cobradoGuia.equals(montoGuia) ? null : montoGuia,
              observaciones: `Ticket de guía sin carnet asociado al grupo '${venta.nombreGrupo}'.`,
              qrFirma: folioGuia.firma,
              ticketPagos: {
                create: {
                  idOpcionPago: opcionPago.id,
                  monto: cobradoGuia,
                  estadoPago: ESTADO_PAGO_PAGADO,
                  fechaPago: getFechaUTC6(fechaEmision),
                  fechaCreacion: ahora,
                  fechaActualizacion: ahora,
                },
              },
            },
          });

          await this.marcarEmitido(tx, folioGuia.id, ticketGuia.id);
          tickets.push(ticketGuia);
        }

        await BitacoraService.registrarEnTransaccion(tx, {
          idUsuario: ejecutor.id,
          usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
          accion: 'EMITIR_TICKET_OFFLINE',
          modulo: MODULO_BITACORA,
          descripcion:
            `Venta OFFLINE del lote ${lote.id} sincronizada: ` +
            `${tickets.map((t) => t.numeroTicket).join(', ')} para '${venta.nombreGrupo}'. ` +
            `Vendida ${fechaEmision.toISOString()}, cobrada ${montoCobrado.toString()}` +
            (folioGuia ? ` (visitante ${cobradoVisitante} + guía ${cobradoGuia})` : '') +
            (hayDiscrepancia ? `, esperada ${esperadoTotal.toString()} (DISCREPANCIA).` : '.'),
        });

        return {
          idLocal: venta.idLocal,
          estado: 'CREADO',
          discrepancia: hayDiscrepancia
            ? {
                montoCobrado: montoCobrado.toString(),
                montoRecalculado: esperadoTotal.toString(),
                diferencia: montoCobrado.minus(esperadoTotal).toString(),
              }
            : null,
          ticket: await this.ticketsService.findOne(ticketVisitante.id, tx),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 },
    );
  }

  /**
   * Acota la fecha del dispositivo al rango en que el lote pudo usarse.
   * Antes de existir el lote no pudo haber venta; después de ahora, tampoco.
   */
  private acotarFecha(fecha: Date, lote: any): Date {
    const minimo = new Date(lote.fechaCreacion);
    const maximo = new Date();

    if (isNaN(fecha.getTime()) || fecha < minimo) return minimo;
    if (fecha > maximo) return maximo;
    return fecha;
  }

  /** Verifica que el folio sirva para esta venta y lo devuelve. */
  private async tomarFolio(tx: any, lote: any, numeroTicket: string) {
    const folio = await tx.folioReservado.findUnique({ where: { numeroTicket } });

    if (!folio) {
      throw this.rechazo(
        'FOLIO_NO_RESERVADO',
        `El folio ${numeroTicket} no corresponde a ningún folio reservado.`,
      );
    }

    if (folio.idLote !== lote.id) {
      throw this.rechazo(
        'FOLIO_DE_OTRO_LOTE',
        `El folio ${numeroTicket} pertenece al lote ${folio.idLote}, no al ${lote.id}.`,
      );
    }

    // Distinto de FOLIO_NO_RESERVADO a propósito: acá el dispositivo gastó dos
    // veces el mismo folio en ventas distintas, así que hay dinero cobrado que se
    // va a perder y alguien tiene que revisarlo.
    if (folio.estado === FOLIO_EMITIDO) {
      throw this.rechazo(
        'FOLIO_YA_EMITIDO',
        `El folio ${numeroTicket} ya respalda otra venta (ticket ${folio.idTicket}).`,
      );
    }

    if (folio.estado !== FOLIO_RESERVADO) {
      throw this.rechazo(
        'FOLIO_NO_RESERVADO',
        `El folio ${numeroTicket} está en estado ${folio.estado} y no puede emitirse.`,
      );
    }

    return folio;
  }

  private async marcarEmitido(tx: any, idFolio: number, idTicket: number) {
    await tx.folioReservado.update({
      where: { id: idFolio },
      data: { estado: FOLIO_EMITIDO, idTicket },
    });
  }

  // -------------------------------------------------------------------------
  // 4. Conciliar
  // -------------------------------------------------------------------------

  async conciliar(idLote: number, dto: ConciliarLoteDto, ejecutor?: EjecutorInfo) {
    const lote = await this.prisma.loteOffline.findUnique({
      where: { id: idLote },
      include: { folios: true },
    });

    if (!lote) {
      throw new NotFoundException(`No se encontró el lote offline con el ID ${idLote}.`);
    }

    if (lote.estado === LOTE_CONCILIADO) {
      throw new BadRequestException(`El lote ${idLote} ya fue conciliado.`);
    }

    if (lote.estado === LOTE_INVALIDADO) {
      throw new BadRequestException(`El lote ${idLote} está invalidado y no puede conciliarse.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const ahora = getFechaUTC6();

      // Todo folio que quedó sin vender pasa a NO_UTILIZADO: así la auditoría no
      // ve huecos inexplicados en la secuencia de folios.
      const sinUsar = lote.folios.filter((f: any) => f.estado === FOLIO_RESERVADO);

      await tx.folioReservado.updateMany({
        where: { idLote, estado: FOLIO_RESERVADO },
        data: { estado: FOLIO_NO_UTILIZADO },
      });

      const emitidos = lote.folios.filter((f: any) => f.estado === FOLIO_EMITIDO);

      // El cliente declara lo que hizo; el contraste revela ventas que se
      // perdieron (almacenamiento corrupto, cola borrada). No se bloquea la
      // conciliación por esto: dejaría la caja sin poder cerrarse.
      const emitidosSet = new Set(emitidos.map((f: any) => f.numeroTicket));
      const advertencias = (dto?.foliosUtilizados ?? [])
        .filter((numero) => !emitidosSet.has(numero))
        .map((numeroTicket) => ({
          numeroTicket,
          detalle: 'Declarado utilizado, sin ticket registrado',
        }));

      const conciliado = await tx.loteOffline.update({
        where: { id: idLote },
        data: { estado: LOTE_CONCILIADO, fechaConciliacion: ahora },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'CONCILIAR_LOTE_OFFLINE',
        modulo: MODULO_BITACORA,
        descripcion:
          `Se concilió el lote ${idLote}: ${emitidos.length} emitidos, ` +
          `${sinUsar.length} no utilizados` +
          (advertencias.length
            ? `, ${advertencias.length} declarados vendidos SIN ticket registrado ` +
              `(${advertencias.map((a) => a.numeroTicket).join(', ')}).`
            : '.'),
      });

      return {
        idLote: conciliado.id,
        estado: conciliado.estado,
        emitidos: emitidos.length,
        noUtilizados: sinUsar.length,
        advertencias,
      };
    });
  }

  // -------------------------------------------------------------------------
  // 5. Invalidar
  // -------------------------------------------------------------------------

  /**
   * Para dispositivo perdido o robado. **Destruye las ventas offline que no se
   * hubieran subido todavía**: ese dinero quedaría cobrado sin ticket. Usar solo
   * cuando el dispositivo no va a volver.
   */
  async invalidar(idLote: number, ejecutor?: EjecutorInfo) {
    const lote = await this.prisma.loteOffline.findUnique({
      where: { id: idLote },
      include: { folios: true },
    });

    if (!lote) {
      throw new NotFoundException(`No se encontró el lote offline con el ID ${idLote}.`);
    }

    if (lote.estado === LOTE_INVALIDADO) {
      throw new BadRequestException(`El lote ${idLote} ya está invalidado.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const porInvalidar = lote.folios.filter((f: any) => f.estado === FOLIO_RESERVADO).length;

      await tx.folioReservado.updateMany({
        where: { idLote, estado: FOLIO_RESERVADO },
        data: { estado: FOLIO_INVALIDADO },
      });

      const invalidado = await tx.loteOffline.update({
        where: { id: idLote },
        data: { estado: LOTE_INVALIDADO },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'INVALIDAR_LOTE_OFFLINE',
        modulo: MODULO_BITACORA,
        descripcion:
          `Se invalidó el lote ${idLote} del dispositivo ${lote.idDispositivo}: ` +
          `${porInvalidar} folios quedaron inutilizables. Las ventas no subidas se pierden.`,
      });

      return {
        idLote: invalidado.id,
        estado: invalidado.estado,
        foliosInvalidados: porInvalidar,
      };
    });
  }
}
