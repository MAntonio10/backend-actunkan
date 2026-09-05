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
import { ActualizarSectorDto, CrearSectorDto } from './dto/crear-sector.dto';

/**
 * Catálogo de sectores del parque.
 *
 * Es la lista que alimenta `idSectorParque` al publicar una actividad, así que se
 * gobierna con el permiso de `ActividadesParque`: no es un módulo aparte, igual que
 * los catálogos de la emisión de tickets viven bajo `EmisionTickets`.
 */
@Injectable()
export class SectoresService {
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
   * Rechaza nombres repetidos, incluidos los de sectores anulados: reactivar el
   * existente es lo correcto, y dos filas con el mismo nombre harían imposible
   * distinguirlas en el selector del formulario.
   */
  private async exigirNombreLibre(tx: any, nombre: string, idExcluido?: number) {
    const existente = await tx.sectorParque.findFirst({ where: { nombre } });

    if (existente && existente.id !== idExcluido) {
      throw new ConflictException(
        `Ya existe un sector registrado con el nombre '${nombre}'${
          existente.anulado ? ', actualmente anulado. Reactívelo en lugar de crear otro.' : '.'
        }`,
      );
    }
  }

  async crear(dto: CrearSectorDto, ejecutor?: EjecutorInfo) {
    const nombre = dto.nombre.trim();

    return this.prisma.$transaction(async (tx) => {
      await this.exigirNombreLibre(tx, nombre);

      const ahora = getFechaUTC6();
      const sector = await tx.sectorParque.create({
        data: { nombre, fechaCreacion: ahora, fechaActualizacion: ahora },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'CREAR_SECTOR',
        modulo: 'ActividadesParque',
        descripcion: `Se creó el sector '${sector.nombre}' (ID ${sector.id}).`,
      });

      return sector;
    });
  }

  async findAll(incluirAnulados = false) {
    return this.prisma.sectorParque.findMany({
      where: incluirAnulados ? {} : { anulado: false },
      orderBy: { nombre: 'asc' },
      include: { _count: { select: { actividades: true } } },
    });
  }

  async findOne(id: number) {
    const sector = await this.prisma.sectorParque.findUnique({
      where: { id },
      include: { _count: { select: { actividades: true } } },
    });

    if (!sector) {
      throw new NotFoundException(`No se encontró el sector con el ID ${id}.`);
    }

    return sector;
  }

  async actualizar(id: number, dto: ActualizarSectorDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const sector = await tx.sectorParque.findUnique({ where: { id } });
      if (!sector) {
        throw new NotFoundException(`No se encontró el sector con el ID ${id}.`);
      }

      const nombre = dto.nombre?.trim();
      if (nombre) await this.exigirNombreLibre(tx, nombre, id);

      const actualizado = await tx.sectorParque.update({
        where: { id },
        data: {
          ...(nombre ? { nombre } : {}),
          fechaActualizacion: getFechaUTC6(),
        },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'EDITAR_SECTOR',
        modulo: 'ActividadesParque',
        descripcion: `Se actualizó el sector '${actualizado.nombre}' (ID ${id}).`,
      });

      return actualizado;
    });
  }

  /**
   * Baja lógica. Las actividades ya publicadas conservan su sector: anularlo lo
   * retira del selector, no reescribe el historial.
   */
  async anular(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const sector = await tx.sectorParque.findUnique({ where: { id } });
      if (!sector) {
        throw new NotFoundException(`No se encontró el sector con el ID ${id}.`);
      }

      if (sector.anulado) {
        throw new BadRequestException(`El sector '${sector.nombre}' ya se encuentra anulado.`);
      }

      const anulado = await tx.sectorParque.update({
        where: { id },
        data: { anulado: true, fechaActualizacion: getFechaUTC6() },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ANULAR_SECTOR',
        modulo: 'ActividadesParque',
        descripcion: `Se anuló el sector '${anulado.nombre}' (ID ${id}).`,
      });

      return anulado;
    });
  }

  async activar(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const sector = await tx.sectorParque.findUnique({ where: { id } });
      if (!sector) {
        throw new NotFoundException(`No se encontró el sector con el ID ${id}.`);
      }

      if (!sector.anulado) {
        throw new BadRequestException(`El sector '${sector.nombre}' ya se encuentra activo.`);
      }

      const activado = await tx.sectorParque.update({
        where: { id },
        data: { anulado: false, fechaActualizacion: getFechaUTC6() },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ACTIVAR_SECTOR',
        modulo: 'ActividadesParque',
        descripcion: `Se reactivó el sector '${activado.nombre}' (ID ${id}).`,
      });

      return activado;
    });
  }
}
