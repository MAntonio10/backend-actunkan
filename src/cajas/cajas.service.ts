import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { AbrirCajaDto } from './dto/abrir-caja.dto';
import { CerrarCajaDto } from './dto/cerrar-caja.dto';
import { QueryCajaDto } from './dto/query-caja.dto';
import { getFechaUTC6 } from '../common/utils/date.util';

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
  gastos: { where: { anulado: false }, include: { tipoGasto: true } },
};

@Injectable()
export class CajasService {
  constructor(private readonly prisma: PrismaService) {}

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
   * Calcula el arqueo esperado de una apertura: monto inicial + ventas en efectivo - gastos.
   * Toda la aritmética usa Decimal: con dinero, los flotantes de JS no son exactos.
   */
  private async calcularArqueo(client: any, idApertura: number, montoInicial: any) {
    const [ventas, gastos] = await Promise.all([
      client.ticketPago.aggregate({
        _sum: { monto: true },
        where: {
          anulado: false,
          opcionPago: { esEfectivo: true },
          tickets: { idAperturaCaja: idApertura, anulado: false },
        },
      }),
      client.gastos.aggregate({
        _sum: { monto: true },
        where: { idAperturaCaja: idApertura, anulado: false },
      }),
    ]);

    const ventasEfectivo = new Prisma.Decimal(ventas._sum.monto ?? 0);
    const totalGastos = new Prisma.Decimal(gastos._sum.monto ?? 0);
    const montoEsperado = new Prisma.Decimal(montoInicial).plus(ventasEfectivo).minus(totalGastos);

    return { ventasEfectivo, totalGastos, montoEsperado };
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

  async findAll(query: QueryCajaDto) {
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

    return this.prisma.aperturaCaja.findMany({
      where,
      include: INCLUDE_DETALLE,
      orderBy: { fechaCreacion: 'desc' },
    });
  }

  async obtenerActual() {
    return this.prisma.aperturaCaja.findFirst({
      where: { anulado: false, estado: { nombre: ESTADO_ABIERTA } },
      include: INCLUDE_DETALLE,
    });
  }

  async findOne(id: number) {
    const apertura = await this.prisma.aperturaCaja.findUnique({
      where: { id },
      include: INCLUDE_DETALLE,
    });

    if (!apertura) {
      throw new NotFoundException(`No se encontró la caja solicitada con el ID ${id}.`);
    }

    return apertura;
  }

  async arqueo(id: number) {
    const apertura = await this.findOne(id);
    const { ventasEfectivo, totalGastos, montoEsperado } = await this.calcularArqueo(
      this.prisma,
      apertura.id,
      apertura.montoInicial,
    );

    return {
      idApertura: apertura.id,
      montoInicial: Number(apertura.montoInicial),
      ventasEfectivo: ventasEfectivo.toNumber(),
      totalGastos: totalGastos.toNumber(),
      montoEsperado: montoEsperado.toNumber(),
    };
  }

  async cerrarCaja(id: number, dto: CerrarCajaDto, ejecutor?: EjecutorInfo) {
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

      const { ventasEfectivo, totalGastos, montoEsperado } = await this.calcularArqueo(
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

      return { apertura: aperturaActualizada, cierre };
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
