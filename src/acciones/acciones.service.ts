import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CreateAccionDto } from './dto/create-accion.dto';
import { UpdateAccionDto } from './dto/update-accion.dto';

export interface EjecutorInfo {
  id: number;
  email?: string;
}

@Injectable()
export class AccionesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createAccionDto: CreateAccionDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const accionExistente = await tx.accion.findUnique({
        where: { nombre: createAccionDto.nombre },
      });

      if (accionExistente) {
        throw new ConflictException(
          `Ya existe una acción registrada con el nombre '${createAccionDto.nombre}'.`,
        );
      }

      const accion = await tx.accion.create({
        data: {
          nombre: createAccionDto.nombre,
        },
      });

      let nombreEjecutor = ejecutor?.email;
      if (ejecutor?.id) {
        const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
        if (uEj) nombreEjecutor = uEj.nombre;
      }

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: nombreEjecutor,
        accion: 'CREAR_ACCION',
        modulo: 'Acciones',
        descripcion: `Se creo la nueva accion '${accion.nombre}'.`,
      });

      return accion;
    });
  }

  async findAll() {
    return this.prisma.accion.findMany({
      orderBy: { nombre: 'asc' },
    });
  }

  async findOne(id: number) {
    const accion = await this.prisma.accion.findUnique({
      where: { id },
    });

    if (!accion) {
      throw new NotFoundException(`No se encontró la acción solicitada con el ID ${id}.`);
    }

    return accion;
  }

  async update(id: number, updateAccionDto: UpdateAccionDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const accion = await tx.accion.findUnique({ where: { id } });
      if (!accion) {
        throw new NotFoundException(`No se encontró la acción solicitada con el ID ${id}.`);
      }

      if (updateAccionDto.nombre) {
        const otraAccion = await tx.accion.findUnique({
          where: { nombre: updateAccionDto.nombre },
        });

        if (otraAccion && otraAccion.id !== id) {
          throw new ConflictException(
            `Ya existe otra acción registrada con el nombre '${updateAccionDto.nombre}'.`,
          );
        }
      }

      const accionActualizada = await tx.accion.update({
        where: { id },
        data: updateAccionDto,
      });

      let nombreEjecutor = ejecutor?.email;
      if (ejecutor?.id) {
        const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
        if (uEj) nombreEjecutor = uEj.nombre;
      }

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: nombreEjecutor,
        accion: 'EDITAR_ACCION',
        modulo: 'Acciones',
        descripcion: `Se actualizaron los datos de la acción '${accionActualizada.nombre}' (ID: ${id}).`,
      });

      return accionActualizada;
    });
  }

  async remove(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const accion = await tx.accion.findUnique({ where: { id } });
      if (!accion) {
        throw new NotFoundException(`No se encontró la acción solicitada con el ID ${id}.`);
      }

      const moduloAcciones = await tx.moduloAccion.findMany({
        where: { idAccion: id },
        select: { id: true },
      });
      const idsModuloAccion = moduloAcciones.map((ma) => ma.id);

      if (idsModuloAccion.length > 0) {
        await tx.permisos.deleteMany({
          where: { idModuloAccion: { in: idsModuloAccion } },
        });

        await tx.moduloAccion.deleteMany({
          where: { idAccion: id },
        });
      }

      const accionEliminada = await tx.accion.delete({
        where: { id },
      });

      let nombreEjecutor = ejecutor?.email;
      if (ejecutor?.id) {
        const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
        if (uEj) nombreEjecutor = uEj.nombre;
      }

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: nombreEjecutor,
        accion: 'ELIMINAR_ACCION',
        modulo: 'Acciones',
        descripcion: `Se eliminó la acción '${accionEliminada.nombre}' (ID: ${id}).`,
      });

      return accionEliminada;
    });
  }
}
