import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePuestoDto } from './dto/create-puesto.dto';
import { UpdatePuestoDto } from './dto/update-puesto.dto';
import { getFechaUTC6 } from '../common/utils/date.util';

@Injectable()
export class PuestosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createPuestoDto: CreatePuestoDto) {
    return this.prisma.$transaction(async (tx) => {
      const puestoExistente = await tx.puestos.findUnique({
        where: { nombre: createPuestoDto.nombre },
      });

      if (puestoExistente) {
        throw new ConflictException(
          `Ya existe un puesto registrado con el nombre '${createPuestoDto.nombre}'.`,
        );
      }

      const ahora = getFechaUTC6();
      return tx.puestos.create({
        data: {
          nombre: createPuestoDto.nombre,
          descripcion: createPuestoDto.descripcion,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        },
      });
    });
  }

  async findAll(incluirAnulados = false) {
    return this.prisma.puestos.findMany({
      where: incluirAnulados ? {} : { anulado: false },
      orderBy: { nombre: 'asc' },
    });
  }

  async findOne(id: number) {
    const puesto = await this.prisma.puestos.findUnique({
      where: { id },
      include: {
        _count: {
          select: { usuarios: true },
        },
      },
    });

    if (!puesto) {
      throw new NotFoundException(`No se encontró el puesto solicitado con el ID ${id}.`);
    }

    return puesto;
  }

  async update(id: number, updatePuestoDto: UpdatePuestoDto) {
    return this.prisma.$transaction(async (tx) => {
      const puesto = await tx.puestos.findUnique({ where: { id } });
      if (!puesto) {
        throw new NotFoundException(`No se encontró el puesto solicitado con el ID ${id}.`);
      }

      if (updatePuestoDto.nombre) {
        const otroPuesto = await tx.puestos.findUnique({
          where: { nombre: updatePuestoDto.nombre },
        });

        if (otroPuesto && otroPuesto.id !== id) {
          throw new ConflictException(
            `Ya existe otro puesto registrado con el nombre '${updatePuestoDto.nombre}'.`,
          );
        }
      }

      return tx.puestos.update({
        where: { id },
        data: {
          ...updatePuestoDto,
          fechaActualizacion: getFechaUTC6(),
        },
      });
    });
  }

  async remove(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const puesto = await tx.puestos.findUnique({ where: { id } });
      if (!puesto) {
        throw new NotFoundException(`No se encontró el puesto solicitado con el ID ${id}.`);
      }

      return tx.puestos.update({
        where: { id },
        data: {
          anulado: true,
          fechaActualizacion: getFechaUTC6(),
        },
      });
    });
  }
}
