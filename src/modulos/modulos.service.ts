import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CreateModuloDto } from './dto/create-modulo.dto';
import { UpdateModuloDto } from './dto/update-modulo.dto';
import { getFechaUTC6 } from '../common/utils/date.util';

export interface EjecutorInfo {
  id: number;
  email?: string;
}

@Injectable()
export class ModulosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createModuloDto: CreateModuloDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const moduloExistente = await tx.modulo.findUnique({
        where: { nombre: createModuloDto.nombre },
      });

      if (moduloExistente) {
        throw new ConflictException(
          `Ya existe un módulo registrado con el nombre '${createModuloDto.nombre}'.`,
        );
      }

      const ahora = getFechaUTC6();
      const modulo = await tx.modulo.create({
        data: {
          nombre: createModuloDto.nombre,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
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
        accion: 'CREAR_MODULO',
        modulo: 'Modulos',
        descripcion: `Se creó el nuevo módulo de sistema '${modulo.nombre}'.`,
      });

      return modulo;
    });
  }

  async findAll(incluirAnulados = false) {
    return this.prisma.modulo.findMany({
      where: incluirAnulados ? {} : { anulado: false },
      include: {
        moduloAcciones: {
          include: {
            accion: true,
          },
        },
      },
      orderBy: { nombre: 'asc' },
    });
  }

  async findOne(id: number) {
    const modulo = await this.prisma.modulo.findUnique({
      where: { id },
      include: {
        moduloAcciones: {
          include: {
            accion: true,
          },
        },
      },
    });

    if (!modulo) {
      throw new NotFoundException(`No se encontró el módulo solicitado con el ID ${id}.`);
    }

    return modulo;
  }

  async update(id: number, updateModuloDto: UpdateModuloDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const modulo = await tx.modulo.findUnique({ where: { id } });
      if (!modulo) {
        throw new NotFoundException(`No se encontró el módulo solicitado con el ID ${id}.`);
      }

      if (updateModuloDto.nombre) {
        const otroModulo = await tx.modulo.findUnique({
          where: { nombre: updateModuloDto.nombre },
        });

        if (otroModulo && otroModulo.id !== id) {
          throw new ConflictException(
            `Ya existe otro módulo registrado con el nombre '${updateModuloDto.nombre}'.`,
          );
        }
      }

      const moduloActualizado = await tx.modulo.update({
        where: { id },
        data: {
          ...updateModuloDto,
          fechaActualizacion: getFechaUTC6(),
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
        accion: 'EDITAR_MODULO',
        modulo: 'Modulos',
        descripcion: `Se actualizaron los datos del módulo '${moduloActualizado.nombre}' (ID: ${id}).`,
      });

      return moduloActualizado;
    });
  }

  async remove(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const modulo = await tx.modulo.findUnique({ where: { id } });
      if (!modulo) {
        throw new NotFoundException(`No se encontró el módulo solicitado con el ID ${id}.`);
      }

      const moduloAnulado = await tx.modulo.update({
        where: { id },
        data: {
          anulado: true,
          fechaActualizacion: getFechaUTC6(),
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
        accion: 'ANULAR_MODULO',
        modulo: 'Modulos',
        descripcion: `Se deshabilitó/anuló el módulo '${moduloAnulado.nombre}' (ID: ${id}).`,
      });

      return moduloAnulado;
    });
  }

  async activar(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const modulo = await tx.modulo.findUnique({ where: { id } });
      if (!modulo) {
        throw new NotFoundException(`No se encontró el módulo solicitado con el ID ${id}.`);
      }

      if (!modulo.anulado) {
        throw new BadRequestException(`El módulo '${modulo.nombre}' ya se encuentra activo.`);
      }

      const moduloActivado = await tx.modulo.update({
        where: { id },
        data: {
          anulado: false,
          fechaActualizacion: getFechaUTC6(),
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
        accion: 'ACTIVAR_MODULO',
        modulo: 'Modulos',
        descripcion: `Se reactivó el módulo '${moduloActivado.nombre}' (ID: ${id}).`,
      });

      return moduloActivado;
    });
  }
}
