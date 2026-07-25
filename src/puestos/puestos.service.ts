import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CreatePuestoDto } from './dto/create-puesto.dto';
import { UpdatePuestoDto } from './dto/update-puesto.dto';
import { getFechaUTC6 } from '../common/utils/date.util';

export interface EjecutorInfo {
  id: number;
  email?: string;
}

@Injectable()
export class PuestosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createPuestoDto: CreatePuestoDto, ejecutor?: EjecutorInfo) {
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
      const puesto = await tx.puestos.create({
        data: {
          nombre: createPuestoDto.nombre,
          descripcion: createPuestoDto.descripcion,
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
        accion: 'CREAR_PUESTO',
        modulo: 'Puestos',
        descripcion: `Se creó el nuevo puesto '${puesto.nombre}'.`,
      });

      return puesto;
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

  async update(id: number, updatePuestoDto: UpdatePuestoDto, ejecutor?: EjecutorInfo) {
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

      const puestoActualizado = await tx.puestos.update({
        where: { id },
        data: {
          ...updatePuestoDto,
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
        accion: 'EDITAR_PUESTO',
        modulo: 'Puestos',
        descripcion: `Se actualizaron los datos del puesto '${puestoActualizado.nombre}' (ID: ${id}).`,
      });

      return puestoActualizado;
    });
  }

  async remove(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const puesto = await tx.puestos.findUnique({ where: { id } });
      if (!puesto) {
        throw new NotFoundException(`No se encontró el puesto solicitado con el ID ${id}.`);
      }

      const puestoAnulado = await tx.puestos.update({
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
        accion: 'ANULAR_PUESTO',
        modulo: 'Puestos',
        descripcion: `Se anuló/deshabilitó el puesto '${puestoAnulado.nombre}' (ID: ${id}).`,
      });

      return puestoAnulado;
    });
  }

  async activar(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const puesto = await tx.puestos.findUnique({ where: { id } });
      if (!puesto) {
        throw new NotFoundException(`No se encontró el puesto solicitado con el ID ${id}.`);
      }

      if (!puesto.anulado) {
        throw new BadRequestException(`El puesto '${puesto.nombre}' ya se encuentra activo.`);
      }

      const puestoActivado = await tx.puestos.update({
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
        accion: 'ACTIVAR_PUESTO',
        modulo: 'Puestos',
        descripcion: `Se reactivó el puesto '${puestoActivado.nombre}' (ID: ${id}).`,
      });

      return puestoActivado;
    });
  }
}
