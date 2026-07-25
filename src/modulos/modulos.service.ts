import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateModuloDto } from './dto/create-modulo.dto';
import { UpdateModuloDto } from './dto/update-modulo.dto';
import { getFechaUTC6 } from '../common/utils/date.util';

@Injectable()
export class ModulosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createModuloDto: CreateModuloDto) {
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
      return tx.modulo.create({
        data: {
          nombre: createModuloDto.nombre,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        },
      });
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

  async update(id: number, updateModuloDto: UpdateModuloDto) {
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

      return tx.modulo.update({
        where: { id },
        data: {
          ...updateModuloDto,
          fechaActualizacion: getFechaUTC6(),
        },
      });
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const modulo = await tx.modulo.findUnique({ where: { id } });
      if (!modulo) {
        throw new NotFoundException(`No se encontró el módulo solicitado con el ID ${id}.`);
      }

      return tx.modulo.update({
        where: { id },
        data: {
          anulado: true,
          fechaActualizacion: getFechaUTC6(),
        },
      });
    });
  }
}
