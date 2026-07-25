import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CreateModuloAccionDto } from './dto/create-modulo-accion.dto';

export interface EjecutorInfo {
  id: number;
  email?: string;
}

@Injectable()
export class ModuloAccionesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateModuloAccionDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const modulo = await tx.modulo.findUnique({
        where: { id: dto.idModulo },
      });

      if (!modulo) {
        throw new NotFoundException(
          `No existe ningún módulo con el ID ${dto.idModulo}.`,
        );
      }

      const accion = await tx.accion.findUnique({
        where: { id: dto.idAccion },
      });

      if (!accion) {
        throw new NotFoundException(
          `No existe ninguna acción con el ID ${dto.idAccion}.`,
        );
      }

      const relacionExistente = await tx.moduloAccion.findUnique({
        where: {
          idModulo_idAccion: {
            idModulo: dto.idModulo,
            idAccion: dto.idAccion,
          },
        },
      });

      if (relacionExistente) {
        throw new ConflictException(
          `La acción '${accion.nombre}' ya está vinculada al módulo '${modulo.nombre}'.`,
        );
      }

      const nuevaRelacion = await tx.moduloAccion.create({
        data: {
          idModulo: dto.idModulo,
          idAccion: dto.idAccion,
        },
        include: {
          modulo: true,
          accion: true,
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
        accion: 'VINCULAR_MODULO_ACCION',
        modulo: 'Modulos',
        descripcion: `Se vinculó la acción '${accion.nombre}' al módulo '${modulo.nombre}'.`,
      });

      return nuevaRelacion;
    });
  }

  async findAll() {
    return this.prisma.moduloAccion.findMany({
      include: {
        modulo: true,
        accion: true,
      },
      orderBy: [{ modulo: { nombre: 'asc' } }],
    });
  }

  async findByModulo(idModulo: number) {
    const modulo = await this.prisma.modulo.findUnique({
      where: { id: idModulo },
    });

    if (!modulo) {
      throw new NotFoundException(`No existe ningún módulo con el ID ${idModulo}.`);
    }

    return this.prisma.moduloAccion.findMany({
      where: { idModulo },
      include: {
        accion: true,
      },
    });
  }

  async findOne(id: number) {
    const moduloAccion = await this.prisma.moduloAccion.findUnique({
      where: { id },
      include: {
        modulo: true,
        accion: true,
      },
    });

    if (!moduloAccion) {
      throw new NotFoundException(
        `No se encontró la asociación Módulo-Acción solicitada con el ID ${id}.`,
      );
    }

    return moduloAccion;
  }

  async remove(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const moduloAccion = await tx.moduloAccion.findUnique({
        where: { id },
        include: {
          modulo: true,
          accion: true,
        },
      });

      if (!moduloAccion) {
        throw new NotFoundException(
          `No se encontró la asociación Módulo-Acción solicitada con el ID ${id}.`,
        );
      }

      await tx.permisos.deleteMany({
        where: { idModuloAccion: id },
      });

      const desvinculado = await tx.moduloAccion.delete({
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
        accion: 'DESVINCULAR_MODULO_ACCION',
        modulo: 'Modulos',
        descripcion: `Se desvinculó la acción '${moduloAccion.accion?.nombre}' del módulo '${moduloAccion.modulo?.nombre}'.`,
      });

      return desvinculado;
    });
  }
}
