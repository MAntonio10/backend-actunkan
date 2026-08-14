import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../common/utils/date.util';
import { ActualizarTarifaDto, ActualizarTarifaGuiaDto } from './dto/actualizar-tarifa.dto';

/** Única categoría a la que se le permite precio Q0. */
export const CODIGO_NINO_MENOR = 'nino_menor';

const INCLUDE_TARIFA = {
  atraccion: { select: { id: true, codigo: true, nombre: true } },
  origen: { select: { id: true, codigo: true, nombre: true } },
  tipoVisitante: { select: { id: true, codigo: true, nombre: true } },
};

@Injectable()
export class TarifasService {
  constructor(private readonly prisma: PrismaService) {}

  private async obtenerNombreEjecutor(tx: any, ejecutor?: EjecutorInfo) {
    let nombreEjecutor = ejecutor?.email;
    if (ejecutor?.id) {
      const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
      if (uEj) nombreEjecutor = uEj.nombre;
    }
    return nombreEjecutor;
  }

  /** Tarifas vigentes: las que no tienen cierre de vigencia. */
  async findVigentes() {
    return this.prisma.tarifa.findMany({
      where: { vigenteHasta: null, anulado: false },
      include: INCLUDE_TARIFA,
      orderBy: [{ idAtraccion: 'asc' }, { idOrigen: 'asc' }, { idTipoVisitante: 'asc' }],
    });
  }

  /** Historial completo, para auditar cuándo cambió cada precio. */
  async findHistorico(idAtraccion?: number, idOrigen?: number) {
    return this.prisma.tarifa.findMany({
      where: {
        ...(idAtraccion ? { idAtraccion } : {}),
        ...(idOrigen ? { idOrigen } : {}),
      },
      include: INCLUDE_TARIFA,
      orderBy: [{ idAtraccion: 'asc' }, { idOrigen: 'asc' }, { vigenteDesde: 'desc' }],
    });
  }

  async findTarifaGuiaVigente() {
    const tarifa = await this.prisma.tarifaGuia.findFirst({
      where: { vigenteHasta: null },
      orderBy: { vigenteDesde: 'desc' },
    });

    if (!tarifa) {
      throw new NotFoundException(
        'No hay una tarifa vigente para el ticket de guía. Configure el catálogo de tarifas.',
      );
    }

    return tarifa;
  }

  /**
   * Editar un precio no actualiza la fila: cierra la vigencia de la tarifa actual y
   * crea una nueva. Así los tickets ya vendidos conservan el precio con el que se
   * emitieron y queda rastro de cuándo cambió.
   */
  async actualizarTarifa(dto: ActualizarTarifaDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const tipoVisitante = await tx.tipoVisitante.findUnique({
        where: { id: dto.idTipoVisitante },
      });

      if (!tipoVisitante || tipoVisitante.anulado) {
        throw new BadRequestException(
          `El tipo de visitante con ID ${dto.idTipoVisitante} no existe o está anulado.`,
        );
      }

      if (dto.precio <= 0 && tipoVisitante.codigo !== CODIGO_NINO_MENOR) {
        throw new BadRequestException(
          `El precio de '${tipoVisitante.nombre}' debe ser mayor a 0. Solo la categoría de niño menor admite Q0.`,
        );
      }

      const ahora = getFechaUTC6();

      const vigente = await tx.tarifa.findFirst({
        where: {
          idAtraccion: dto.idAtraccion,
          idOrigen: dto.idOrigen,
          idTipoVisitante: dto.idTipoVisitante,
          vigenteHasta: null,
        },
      });

      if (vigente) {
        await tx.tarifa.update({
          where: { id: vigente.id },
          data: { vigenteHasta: ahora, fechaActualizacion: ahora },
        });
      }

      const nueva = await tx.tarifa.create({
        data: {
          idAtraccion: dto.idAtraccion,
          idOrigen: dto.idOrigen,
          idTipoVisitante: dto.idTipoVisitante,
          precio: new Prisma.Decimal(dto.precio),
          vigenteDesde: ahora,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        },
        include: INCLUDE_TARIFA,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'EDITAR_TARIFA',
        modulo: 'Tarifas',
        descripcion:
          `Tarifa de '${nueva.tipoVisitante.nombre}' en '${nueva.atraccion.nombre}' ` +
          `(${nueva.origen.nombre}): ${vigente ? vigente.precio.toString() : 'sin tarifa previa'} -> ${dto.precio}.`,
      });

      return nueva;
    });
  }

  async actualizarTarifaGuia(dto: ActualizarTarifaGuiaDto, ejecutor?: EjecutorInfo) {
    if (dto.precio <= 0) {
      throw new BadRequestException('El precio del ticket de guía debe ser mayor a 0.');
    }

    return this.prisma.$transaction(async (tx) => {
      const ahora = getFechaUTC6();

      const vigente = await tx.tarifaGuia.findFirst({ where: { vigenteHasta: null } });
      if (vigente) {
        await tx.tarifaGuia.update({
          where: { id: vigente.id },
          data: { vigenteHasta: ahora, fechaActualizacion: ahora },
        });
      }

      const nueva = await tx.tarifaGuia.create({
        data: {
          precio: new Prisma.Decimal(dto.precio),
          vigenteDesde: ahora,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'EDITAR_TARIFA_GUIA',
        modulo: 'Tarifas',
        descripcion: `Tarifa del ticket de guía: ${vigente ? vigente.precio.toString() : 'sin tarifa previa'} -> ${dto.precio}.`,
      });

      return nueva;
    });
  }
}
