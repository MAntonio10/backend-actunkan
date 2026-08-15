import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../common/utils/date.util';
import { UpdateGuiaDto } from './dto/update-guia.dto';

@Injectable()
export class GuiasService {
  constructor(private readonly prisma: PrismaService) {}

  private async obtenerNombreEjecutor(tx: any, ejecutor?: EjecutorInfo) {
    let nombreEjecutor = ejecutor?.email;
    if (ejecutor?.id) {
      const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
      if (uEj) nombreEjecutor = uEj.nombre;
    }
    return nombreEjecutor;
  }

  /**
   * Rechaza nombres repetidos entre guías activos. Sin esto el selector se llena de
   * duplicados por errores de captura: cada alta durante la emisión creaba uno nuevo.
   */
  static async exigirNombreLibre(tx: any, nombre: string, idExcluido?: number) {
    const existente = await tx.guia.findFirst({
      where: { nombre: nombre.trim(), anulado: false },
    });

    if (existente && existente.id !== idExcluido) {
      throw new ConflictException(
        `Ya existe un guía activo llamado '${existente.nombre}' (ID ${existente.id}). ` +
          'Selecciónelo de la lista en vez de crear uno nuevo.',
      );
    }
  }

  /** Listado para el selector de guías; `buscar` filtra por nombre. */
  async findAll(buscar?: string, incluirAnulados = false) {
    return this.prisma.guia.findMany({
      where: {
        ...(incluirAnulados ? {} : { anulado: false }),
        ...(buscar ? { nombre: { contains: buscar } } : {}),
      },
      orderBy: { nombre: 'asc' },
    });
  }

  async findOne(id: number) {
    const guia = await this.prisma.guia.findUnique({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });

    if (!guia) {
      throw new NotFoundException(`No se encontró el guía con el ID ${id}.`);
    }

    return guia;
  }

  async update(id: number, dto: UpdateGuiaDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const guia = await tx.guia.findUnique({ where: { id } });
      if (!guia) {
        throw new NotFoundException(`No se encontró el guía con el ID ${id}.`);
      }

      if (dto.nombre) {
        await GuiasService.exigirNombreLibre(tx, dto.nombre, id);
      }

      // El número de carnet solo tiene sentido si el guía declara tenerlo.
      const tieneCarnet = dto.tieneCarnet ?? guia.tieneCarnet;
      const numeroCarnet = dto.numeroCarnet ?? guia.numeroCarnet;

      if (tieneCarnet && !numeroCarnet) {
        throw new BadRequestException(
          'Debe indicar el número de carnet cuando el guía tiene carnet.',
        );
      }

      const actualizado = await tx.guia.update({
        where: { id },
        data: {
          ...(dto.nombre ? { nombre: dto.nombre.trim() } : {}),
          tieneCarnet,
          numeroCarnet: tieneCarnet ? numeroCarnet : null,
          fechaActualizacion: getFechaUTC6(),
        },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'EDITAR_GUIA',
        modulo: 'EmisionTickets',
        descripcion:
          `Se actualizó el guía '${actualizado.nombre}' (ID: ${id}). ` +
          `Carnet: ${actualizado.tieneCarnet ? actualizado.numeroCarnet : 'sin carnet'}.`,
      });

      return actualizado;
    });
  }

  /**
   * Baja lógica: el guía deja de aparecer en el selector, pero los tickets ya
   * emitidos conservan la referencia.
   */
  async remove(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const guia = await tx.guia.findUnique({ where: { id } });
      if (!guia) {
        throw new NotFoundException(`No se encontró el guía con el ID ${id}.`);
      }

      if (guia.anulado) {
        throw new BadRequestException(`El guía '${guia.nombre}' ya se encuentra anulado.`);
      }

      const anulado = await tx.guia.update({
        where: { id },
        data: { anulado: true, fechaActualizacion: getFechaUTC6() },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ANULAR_GUIA',
        modulo: 'EmisionTickets',
        descripcion: `Se anuló el guía '${anulado.nombre}' (ID: ${id}).`,
      });

      return anulado;
    });
  }

  /** Sin esto, un guía anulado por error quedaría inaccesible: no hay alta directa. */
  async activar(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const guia = await tx.guia.findUnique({ where: { id } });
      if (!guia) {
        throw new NotFoundException(`No se encontró el guía con el ID ${id}.`);
      }

      if (!guia.anulado) {
        throw new BadRequestException(`El guía '${guia.nombre}' ya se encuentra activo.`);
      }

      await GuiasService.exigirNombreLibre(tx, guia.nombre, id);

      const activado = await tx.guia.update({
        where: { id },
        data: { anulado: false, fechaActualizacion: getFechaUTC6() },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ACTIVAR_GUIA',
        modulo: 'EmisionTickets',
        descripcion: `Se reactivó el guía '${activado.nombre}' (ID: ${id}).`,
      });

      return activado;
    });
  }
}
