import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { AbrirCajaDto } from './dto/abrir-caja.dto';
import { CerrarCajaDto } from './dto/cerrar-caja.dto';
import { QueryCajaDto } from './dto/query-caja.dto';
import { QueryCierreDto } from './dto/query-cierre.dto';
import { getFechaUTC6 } from '../common/utils/date.util';
import { conciliarLotesVencidos } from '../tickets/conciliar-vencidos.util';

export interface EjecutorInfo {
  id: number;
  email?: string;
}

const ESTADO_ABIERTA = 'Abierta';
const ESTADO_CERRADA = 'Cerrada';

const INCLUDE_DETALLE = {
  usuario: { select: { id: true, nombre: true, correo: true } },
  estado: true,
  cierresCaja: { orderBy: { fechaCierre: 'desc' as const } },
};

@Injectable()
export class CajasService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Supervisión de caja = permiso `Cajas.Editar`.
   *
   * Quien cuenta el efectivo no debe ver el monto esperado: si lo conoce, puede
   * teclear justo esa cifra y un faltante nunca saldría a la luz. Esa acción quedó
   * libre cuando se definió que las cajas son inmutables, así que representa
   * "supervisar" sin necesidad de inventar una acción nueva.
   */
  async esSupervisor(idUsuario?: number): Promise<boolean> {
    if (!idUsuario) return false;

    const permiso = await this.prisma.permisos.findFirst({
      where: {
        idUsuario,
        moduloAccion: {
          modulo: { nombre: 'Cajas', anulado: false },
          accion: { nombre: 'Editar' },
        },
      },
    });

    return Boolean(permiso);
  }

  /** Quita del cierre las cifras que delatan el arqueo. */
  private ocultarArqueoDeCierre(cierre: any) {
    if (!cierre) return cierre;
    const { montoEsperado, diferencia, ...resto } = cierre;
    return resto;
  }

  /**
   * El detalle de la caja trae sus cierres anidados: sin esto, el monto esperado
   * se filtraría por ahí aunque el endpoint de arqueo esté restringido.
   */
  private ocultarArqueoDeCaja(caja: any) {
    if (!caja?.cierresCaja) return caja;
    return {
      ...caja,
      cierresCaja: caja.cierresCaja.map((c: any) => this.ocultarArqueoDeCierre(c)),
    };
  }

  private async obtenerNombreEjecutor(tx: any, ejecutor?: EjecutorInfo) {
    let nombreEjecutor = ejecutor?.email;
    if (ejecutor?.id) {
      const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
      if (uEj) nombreEjecutor = uEj.nombre;
    }
    return nombreEjecutor;
  }

  private async obtenerEstadoIdPorNombre(tx: any, nombre: string): Promise<number> {
    const estado = await tx.estadoCaja.findFirst({ where: { nombre } });
    if (!estado) {
      throw new BadRequestException(
        `No se encontró el estado de caja '${nombre}'. Verifique que el catálogo EstadoCaja esté correctamente configurado.`,
      );
    }
    return estado.id;
  }

  /**
   * Busca la caja abierta vigente. Se usa tanto para impedir aperturas duplicadas
   * como para impedir que una reapertura deje dos cajas abiertas a la vez.
   */
  private async buscarCajaAbierta(client: any, excluirId?: number) {
    return client.aperturaCaja.findFirst({
      where: {
        anulado: false,
        estado: { nombre: ESTADO_ABIERTA },
        ...(excluirId ? { id: { not: excluirId } } : {}),
      },
    });
  }

  /**
   * Arqueo esperado de una apertura: monto inicial + ventas en efectivo + donaciones.
   * Toda la aritmética usa Decimal: con dinero, los flotantes de JS no son exactos.
   */
  private async calcularArqueo(client: any, idApertura: number, montoInicial: any) {
    const [ventas, donaciones] = await Promise.all([
      client.ticketPago.aggregate({
        _sum: { monto: true },
        where: {
          anulado: false,
          // Solo lo efectivamente cobrado: un pago con tarjeta pendiente de
          // confirmación no es dinero en la caja.
          estadoPago: 'PAGADO',
          opcionPago: { esEfectivo: true },
          tickets: { idAperturaCaja: idApertura, anulado: false },
        },
      }),
      // Las donaciones son efectivo que entra al mismo cajón: si no se contaran,
      // cada donación aparecería como sobrante al cerrar.
      client.donacion.aggregate({
        _sum: { monto: true },
        where: { idAperturaCaja: idApertura, anulado: false },
      }),
    ]);

    const ventasEfectivo = new Prisma.Decimal(ventas._sum.monto ?? 0);
    const totalDonaciones = new Prisma.Decimal(donaciones._sum.monto ?? 0);
    const montoEsperado = new Prisma.Decimal(montoInicial)
      .plus(ventasEfectivo)
      .plus(totalDonaciones);

    return {
      ventasEfectivo,
      totalDonaciones,
      montoEsperado,
      discrepanciaOffline: await this.calcularDiscrepanciaOffline(client, idApertura),
    };
  }

  /**
   * Ventas offline en las que se cobró algo distinto de lo que correspondía.
   *
   * **No altera el monto esperado**, y es a propósito: el esperado es el dinero que
   * debería haber en el cajón, y en el cajón está lo que se cobró. Si la
   * discrepancia se restara, el arqueo cuadraría mal y el faltante aparecería como
   * un error del cajero al contar.
   *
   * Por eso va como cifra aparte: sin ella, un cobro de menos no deja ninguna
   * huella en el arqueo —el pago se registró por lo cobrado y el esperado coincide
   * con lo contado— y nadie se entera nunca.
   *
   * `montoRecalculado` solo se guarda cuando difiere de lo cobrado (ver
   * `OfflineService`), así que basta con contar las filas donde no es nulo.
   */
  private async calcularDiscrepanciaOffline(client: any, idApertura: number) {
    const desviados = await client.ticket.aggregate({
      _count: { _all: true },
      _sum: { montoTotal: true, montoRecalculado: true },
      where: {
        idAperturaCaja: idApertura,
        anulado: false,
        origenOffline: true,
        montoRecalculado: { not: null },
      },
    });

    const tickets = desviados._count._all ?? 0;

    if (tickets === 0) return null;

    const montoCobrado = new Prisma.Decimal(desviados._sum.montoTotal ?? 0);
    const montoRecalculado = new Prisma.Decimal(desviados._sum.montoRecalculado ?? 0);

    return {
      tickets,
      montoCobrado: montoCobrado.toString(),
      montoRecalculado: montoRecalculado.toString(),
      // Negativa = se cobró de menos.
      diferencia: montoCobrado.minus(montoRecalculado).toString(),
    };
  }

  async abrirCaja(dto: AbrirCajaDto, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException('No se pudo determinar el usuario que abre la caja.');
    }

    return this.prisma.$transaction(async (tx) => {
      const cajaAbierta = await this.buscarCajaAbierta(tx);

      if (cajaAbierta) {
        throw new ConflictException(
          `Ya existe una caja abierta (ID ${cajaAbierta.id}). Debe cerrarse antes de abrir una nueva.`,
        );
      }

      const idEstadoAbierta = await this.obtenerEstadoIdPorNombre(tx, ESTADO_ABIERTA);
      const ahora = getFechaUTC6();

      const apertura = await tx.aperturaCaja.create({
        data: {
          idUsuario: ejecutor.id,
          montoInicial: dto.montoInicial,
          observaciones: dto.observaciones,
          idEstado: idEstadoAbierta,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'APERTURA_CAJA',
        modulo: 'Cajas',
        descripcion: `Se abrió la caja (ID ${apertura.id}) con un monto inicial de ${dto.montoInicial}.`,
      });

      return apertura;
      // Serializable: sin este nivel, dos peticiones concurrentes pueden pasar
      // ambas la verificación de "no hay caja abierta" y abrir dos cajas.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async findAll(query: QueryCajaDto, idUsuario?: number) {
    const { estado, fechaInicio, fechaFin, incluirAnulados } = query || {};
    const where: any = {};

    if (incluirAnulados !== 'true') {
      where.anulado = false;
    }

    if (estado) {
      where.estado = { nombre: estado };
    }

    if (fechaInicio || fechaFin) {
      where.fechaCreacion = {};
      if (fechaInicio) where.fechaCreacion.gte = new Date(fechaInicio);
      if (fechaFin) where.fechaCreacion.lte = new Date(fechaFin);
    }

    const cajas = await this.prisma.aperturaCaja.findMany({
      where,
      include: INCLUDE_DETALLE,
      orderBy: { fechaCreacion: 'desc' },
    });

    if (await this.esSupervisor(idUsuario)) return cajas;
    return cajas.map((c) => this.ocultarArqueoDeCaja(c));
  }

  async obtenerActual() {
    return this.prisma.aperturaCaja.findFirst({
      where: { anulado: false, estado: { nombre: ESTADO_ABIERTA } },
      include: INCLUDE_DETALLE,
    });
  }

  /**
   * `idUsuario` decide si la respuesta incluye las cifras del arqueo. Se omite en
   * las llamadas internas (emisión de tickets, donaciones), que no exponen nada.
   */
  async findOne(id: number, idUsuario?: number) {
    const apertura = await this.prisma.aperturaCaja.findUnique({
      where: { id },
      include: INCLUDE_DETALLE,
    });

    if (!apertura) {
      throw new NotFoundException(`No se encontró la caja solicitada con el ID ${id}.`);
    }

    if (idUsuario === undefined || (await this.esSupervisor(idUsuario))) return apertura;
    return this.ocultarArqueoDeCaja(apertura);
  }

  /**
   * Historial de cierres para supervisión: incluye los anulados, que son la señal
   * de que una caja se reabrió para corregir un monto.
   */
  async historialCierres(query: QueryCierreDto) {
    const { idUsuario, fechaInicio, fechaFin, soloAnulados, incluirAnulados } = query || {};
    const pagina = query?.pagina && query.pagina > 0 ? query.pagina : 1;
    const limite = query?.limite && query.limite > 0 ? query.limite : 50;

    const where: any = {};

    if (soloAnulados === 'true') where.anulado = true;
    else if (incluirAnulados !== 'true') where.anulado = false;

    if (idUsuario) where.aperturaCaja = { idUsuario };

    if (fechaInicio || fechaFin) {
      where.fechaCierre = {};
      if (fechaInicio) where.fechaCierre.gte = new Date(fechaInicio);
      if (fechaFin) where.fechaCierre.lte = new Date(fechaFin);
    }

    const [datos, total, agregados] = await Promise.all([
      this.prisma.cierreCaja.findMany({
        where,
        include: {
          aperturaCaja: {
            include: {
              usuario: { select: { id: true, nombre: true, correo: true } },
              estado: true,
            },
          },
        },
        orderBy: { fechaCierre: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
      }),
      this.prisma.cierreCaja.count({ where }),
      this.prisma.cierreCaja.aggregate({
        where,
        _sum: { montoFinal: true, montoEsperado: true, diferencia: true },
      }),
    ]);

    return {
      datos,
      total,
      pagina,
      limite,
      metricas: {
        totalCierres: total,
        totalContado: (agregados._sum.montoFinal ?? new Prisma.Decimal(0)).toString(),
        totalEsperado: (agregados._sum.montoEsperado ?? new Prisma.Decimal(0)).toString(),
        diferenciaAcumulada: (agregados._sum.diferencia ?? new Prisma.Decimal(0)).toString(),
      },
    };
  }

  async arqueo(id: number) {
    const apertura = await this.findOne(id);
    const { ventasEfectivo, totalDonaciones, montoEsperado, discrepanciaOffline } =
      await this.calcularArqueo(this.prisma, apertura.id, apertura.montoInicial);

    return {
      idApertura: apertura.id,
      montoInicial: Number(apertura.montoInicial),
      ventasEfectivo: ventasEfectivo.toNumber(),
      totalDonaciones: totalDonaciones.toNumber(),
      montoEsperado: montoEsperado.toNumber(),
      // Este endpoint ya exige `Cajas.Editar`, así que la cifra solo llega a un
      // supervisor. Es `null` cuando ninguna venta offline se cobró mal.
      discrepanciaOffline,
    };
  }

  async cerrarCaja(id: number, dto: CerrarCajaDto, ejecutor?: EjecutorInfo) {
    // Se resuelve antes de la transacción para decidir si la respuesta puede
    // revelar el arqueo: quien cuenta el efectivo no debe ver la diferencia,
    // o bastaría anular y volver a cerrar hasta cuadrar.
    const supervisa = await this.esSupervisor(ejecutor?.id);

    return this.prisma.$transaction(async (tx) => {
      const apertura = await tx.aperturaCaja.findUnique({
        where: { id },
        include: { estado: true },
      });

      if (!apertura) {
        throw new NotFoundException(`No se encontró la caja solicitada con el ID ${id}.`);
      }

      if (apertura.anulado || apertura.estado.nombre !== ESTADO_ABIERTA) {
        throw new BadRequestException('La caja ya se encuentra cerrada o anulada.');
      }

      await this.exigirSinLotesOfflinePendientes(tx, apertura.id, dto, supervisa, ejecutor);

      const { ventasEfectivo, montoEsperado, discrepanciaOffline } = await this.calcularArqueo(
        tx,
        apertura.id,
        apertura.montoInicial,
      );
      const diferencia = new Prisma.Decimal(dto.montoContado).minus(montoEsperado);

      const idEstadoCerrada = await this.obtenerEstadoIdPorNombre(tx, ESTADO_CERRADA);
      const ahora = getFechaUTC6();

      const cierre = await tx.cierreCaja.create({
        data: {
          idApertura: apertura.id,
          fechaCierre: ahora,
          montoFinal: dto.montoContado,
          montoEsperado,
          diferencia,
          observaciones: dto.observaciones,
        },
      });

      const aperturaActualizada = await tx.aperturaCaja.update({
        where: { id: apertura.id },
        data: { idEstado: idEstadoCerrada, fechaActualizacion: ahora },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'CIERRE_CAJA',
        modulo: 'Cajas',
        descripcion: `Se cerró la caja (ID ${apertura.id}). Monto esperado: ${montoEsperado}, monto contado: ${dto.montoContado}, diferencia: ${diferencia}.`,
      });

      return {
        apertura: supervisa ? aperturaActualizada : this.ocultarArqueoDeCaja(aperturaActualizada),
        cierre: supervisa ? cierre : this.ocultarArqueoDeCierre(cierre),
        // Misma regla que `montoEsperado`: quien cobró de menos no debería ver si
        // el sistema lo detectó.
        ...(supervisa ? { discrepanciaOffline } : {}),
      };
    });
  }

  /**
   * Una venta offline de las 10:00 que se sube a las 16:00 no puede entrar en una
   * caja que se cerró a las 14:00: alteraría un arqueo ya guardado. Por eso el
   * turno se cierra con conexión, que es cuando de todos modos se cuenta el
   * efectivo.
   */
  private async exigirSinLotesOfflinePendientes(
    tx: any,
    idApertura: number,
    dto: CerrarCajaDto,
    supervisa: boolean,
    ejecutor?: EjecutorInfo,
  ) {
    const activos = await tx.loteOffline.findMany({
      where: { idAperturaCaja: idApertura, estado: 'ACTIVO' },
      orderBy: { id: 'asc' },
    });

    if (activos.length === 0) return;

    const ahora = getFechaUTC6();
    const vencidos = activos.filter((l: any) => l.expiraEn <= ahora);
    const vigentes = activos.filter((l: any) => l.expiraEn > ahora);

    // Un lote vencido ya no lo usa nadie: el dispositivo reservó otro al día
    // siguiente. Exigir que alguien lo concilie dejaría esta caja imposible de
    // cerrar y, como solo puede haber una abierta, bloquearía la operación entera.
    if (vencidos.length > 0) {
      await conciliarLotesVencidos(tx, vencidos, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        motivo: `cierre de la caja ${idApertura}`,
      });
    }

    // Los que siguen vigentes sí bloquean: el dispositivo todavía puede estar
    // vendiendo, y esas ventas tienen que entrar antes de congelar el arqueo.
    if (vigentes.length === 0) return;

    const lote = vigentes[0];
    const foliosReservados = await tx.folioReservado.count({
      where: { idLote: lote.id, estado: 'RESERVADO' },
    });

    if (!dto.forzarLoteOffline) {
      throw new ConflictException({
        codigo: 'LOTE_OFFLINE_PENDIENTE',
        idLote: lote.id,
        foliosReservados,
        message:
          `La caja tiene el lote offline ${lote.id} activo, con ${foliosReservados} folios sin ` +
          'liquidar. Suba la cola de ventas del dispositivo y concilie el lote antes de cerrar.',
      });
    }

    // Forzar destruye las ventas que el dispositivo no haya subido: ese dinero
    // queda cobrado sin ticket. Es supervisión, no una acción de cajero.
    if (!supervisa) {
      throw new ForbiddenException(
        'Forzar el cierre con un lote offline pendiente requiere permiso de supervisión (Cajas.Editar).',
      );
    }

    await tx.folioReservado.updateMany({
      where: { idLote: lote.id, estado: 'RESERVADO' },
      data: { estado: 'INVALIDADO' },
    });

    await tx.loteOffline.update({
      where: { id: lote.id },
      data: { estado: 'INVALIDADO' },
    });

    await BitacoraService.registrarEnTransaccion(tx, {
      idUsuario: ejecutor?.id,
      usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
      accion: 'FORZAR_CIERRE_LOTE_OFFLINE',
      modulo: 'Cajas',
      descripcion:
        `Se forzó el cierre de la caja ${idApertura} invalidando el lote offline ${lote.id}: ` +
        `${foliosReservados} folios quedaron inutilizables. Las ventas que el dispositivo no ` +
        'haya subido se pierden.',
    });
  }

  async anularCierre(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const apertura = await tx.aperturaCaja.findUnique({
        where: { id },
        include: {
          estado: true,
          cierresCaja: { where: { anulado: false }, orderBy: { fechaCierre: 'desc' } },
        },
      });

      if (!apertura) {
        throw new NotFoundException(`No se encontró la caja solicitada con el ID ${id}.`);
      }

      const cierreVigente = apertura.cierresCaja[0];

      if (apertura.estado.nombre !== ESTADO_CERRADA || !cierreVigente) {
        throw new BadRequestException('La caja no tiene un cierre vigente para anular.');
      }

      // Reabrir esta caja mientras otra está abierta dejaría dos cajas abiertas
      // a la vez, rompiendo el invariante del módulo.
      const otraAbierta = await this.buscarCajaAbierta(tx, apertura.id);
      if (otraAbierta) {
        throw new ConflictException(
          `No se puede reabrir la caja (ID ${apertura.id}) porque ya existe otra caja abierta (ID ${otraAbierta.id}).`,
        );
      }

      await tx.cierreCaja.update({
        where: { id: cierreVigente.id },
        data: { anulado: true },
      });

      const idEstadoAbierta = await this.obtenerEstadoIdPorNombre(tx, ESTADO_ABIERTA);
      const ahora = getFechaUTC6();

      const aperturaActualizada = await tx.aperturaCaja.update({
        where: { id: apertura.id },
        data: { idEstado: idEstadoAbierta, fechaActualizacion: ahora },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ANULAR_CIERRE_CAJA',
        modulo: 'Cajas',
        descripcion: `Se anuló el cierre (ID ${cierreVigente.id}) de la caja (ID ${apertura.id}) y se reabrió la caja.`,
      });

      return aperturaActualizada;
      // Serializable: la reapertura depende de que no aparezca otra caja abierta
      // entre la verificación y el update.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async anularApertura(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const apertura = await tx.aperturaCaja.findUnique({
        where: { id },
        include: { estado: true },
      });

      if (!apertura) {
        throw new NotFoundException(`No se encontró la caja solicitada con el ID ${id}.`);
      }

      if (apertura.anulado) {
        throw new BadRequestException(`La apertura de caja (ID ${id}) ya se encuentra anulada.`);
      }

      if (apertura.estado.nombre !== ESTADO_ABIERTA) {
        throw new BadRequestException(
          'Solo se puede anular una apertura mientras se encuentra abierta. Anule primero el cierre vigente.',
        );
      }

      // Anular una caja con movimientos dejaría esos tickets y donaciones apuntando
      // a una apertura anulada: dinero cobrado que no pertenecería a ningún arqueo.
      // Para ese caso la salida correcta es cerrarla, no anularla.
      const [tickets, donaciones] = await Promise.all([
        tx.ticket.count({ where: { idAperturaCaja: id, anulado: false } }),
        tx.donacion.count({ where: { idAperturaCaja: id, anulado: false } }),
      ]);

      if (tickets > 0 || donaciones > 0) {
        const detalle = [
          tickets > 0 ? `${tickets} ticket(s)` : null,
          donaciones > 0 ? `${donaciones} donación(es)` : null,
        ]
          .filter(Boolean)
          .join(' y ');

        throw new BadRequestException(
          `No se puede anular la apertura: la caja ya tiene ${detalle} registrados. ` +
            'Ciérrela en lugar de anularla, o anule primero esos movimientos.',
        );
      }

      const aperturaAnulada = await tx.aperturaCaja.update({
        where: { id },
        data: { anulado: true, fechaActualizacion: getFechaUTC6() },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ANULAR_APERTURA_CAJA',
        modulo: 'Cajas',
        descripcion: `Se anuló la apertura de caja (ID ${id}).`,
      });

      return aperturaAnulada;
    });
  }
}
