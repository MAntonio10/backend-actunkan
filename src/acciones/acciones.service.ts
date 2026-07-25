import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAccionDto } from './dto/create-accion.dto';
import { UpdateAccionDto } from './dto/update-accion.dto';

@Injectable()
export class AccionesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createAccionDto: CreateAccionDto) {
    return this.prisma.$transaction(async (tx) => {
      const accionExistente = await tx.accion.findUnique({
        where: { nombre: createAccionDto.nombre },
      });

      if (accionExistente) {
        throw new ConflictException(
          `Ya existe una acción registrada con el nombre '${createAccionDto.nombre}'.`,
        );
      }

      return tx.accion.create({
        data: {
          nombre: createAccionDto.nombre,
        },
      });
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

  async update(id: number, updateAccionDto: UpdateAccionDto) {
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

      return tx.accion.update({
        where: { id },
        data: updateAccionDto,
      });
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const accion = await tx.accion.findUnique({ where: { id } });
      if (!accion) {
        throw new NotFoundException(`No se encontró la acción solicitada con el ID ${id}.`);
      }

      return tx.accion.delete({
        where: { id },
      });
    });
  }
}
