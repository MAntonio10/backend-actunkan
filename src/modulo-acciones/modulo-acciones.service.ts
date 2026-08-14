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
        descripcion: `Se vinculo la accion '${accion.nombre}' al modulo '${modulo.nombre}'.`,
      });

      return nuevaRelacion;
    });
  }

  /**
   * Por defecto devuelve solo lo que realmente se puede conceder a un usuario:
   * módulos activos y asignables.
   *
   * Antes devolvía todo, y una pantalla de "seleccionar todos los permisos" acababa
   * enviando vínculos de módulos de infraestructura (`Modulos`, `Acciones`) o de
   * módulos anulados, que el guard nunca honraría.
   */
  async findAll(incluirNoAsignables = false) {
    return this.prisma.moduloAccion.findMany({
      where: incluirNoAsignables ? {} : { modulo: { esAsignable: true, anulado: false } },
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
        descripcion: `Se desvinculo la accion '${moduloAccion.accion?.nombre}' del modulo '${moduloAccion.modulo?.nombre}'.`,
      });

      return desvinculado;
    });
  }
}
