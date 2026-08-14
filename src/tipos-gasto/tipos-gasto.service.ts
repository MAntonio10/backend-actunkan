import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CreateTipoGastoDto } from './dto/create-tipo-gasto.dto';
import { UpdateTipoGastoDto } from './dto/update-tipo-gasto.dto';

export interface EjecutorInfo {
  id: number;
  email?: string;
}

@Injectable()
export class TiposGastoService {
  constructor(private readonly prisma: PrismaService) {}

  private async obtenerNombreEjecutor(tx: any, ejecutor?: EjecutorInfo) {
    let nombreEjecutor = ejecutor?.email;
    if (ejecutor?.id) {
      const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
      if (uEj) nombreEjecutor = uEj.nombre;
    }
    return nombreEjecutor;
  }

  async create(createTipoGastoDto: CreateTipoGastoDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const existente = await tx.tipoGasto.findFirst({
        where: { nombre: createTipoGastoDto.nombre },
      });

      if (existente) {
        throw new ConflictException(
          `Ya existe un tipo de gasto registrado con el nombre '${createTipoGastoDto.nombre}'.`,
        );
      }

      const tipoGasto = await tx.tipoGasto.create({
        data: { nombre: createTipoGastoDto.nombre },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'CREAR_TIPO_GASTO',
        modulo: 'TiposGasto',
        descripcion: `Se creó el nuevo tipo de gasto '${tipoGasto.nombre}'.`,
      });

      return tipoGasto;
    });
  }

  async findAll(incluirAnulados = false) {
    return this.prisma.tipoGasto.findMany({
      where: incluirAnulados ? {} : { anulado: false },
      orderBy: { nombre: 'asc' },
    });
  }

  async findOne(id: number) {
    const tipoGasto = await this.prisma.tipoGasto.findUnique({
      where: { id },
      include: {
        _count: {
          select: { gastos: true },
        },
      },
    });

    if (!tipoGasto) {
      throw new NotFoundException(`No se encontró el tipo de gasto solicitado con el ID ${id}.`);
    }

    return tipoGasto;
  }

  async update(id: number, updateTipoGastoDto: UpdateTipoGastoDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const tipoGasto = await tx.tipoGasto.findUnique({ where: { id } });
      if (!tipoGasto) {
        throw new NotFoundException(`No se encontró el tipo de gasto solicitado con el ID ${id}.`);
      }

      if (updateTipoGastoDto.nombre) {
        const otro = await tx.tipoGasto.findFirst({
          where: { nombre: updateTipoGastoDto.nombre },
        });

        if (otro && otro.id !== id) {
          throw new ConflictException(
            `Ya existe otro tipo de gasto registrado con el nombre '${updateTipoGastoDto.nombre}'.`,
          );
        }
      }

      const tipoGastoActualizado = await tx.tipoGasto.update({
        where: { id },
        data: { ...updateTipoGastoDto },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'EDITAR_TIPO_GASTO',
        modulo: 'TiposGasto',
        descripcion: `Se actualizaron los datos del tipo de gasto '${tipoGastoActualizado.nombre}' (ID: ${id}).`,
      });

      return tipoGastoActualizado;
    });
  }

  async remove(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const tipoGasto = await tx.tipoGasto.findUnique({ where: { id } });
      if (!tipoGasto) {
        throw new NotFoundException(`No se encontró el tipo de gasto solicitado con el ID ${id}.`);
      }

      const tipoGastoAnulado = await tx.tipoGasto.update({
        where: { id },
        data: { anulado: true },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ANULAR_TIPO_GASTO',
        modulo: 'TiposGasto',
        descripcion: `Se anuló/deshabilitó el tipo de gasto '${tipoGastoAnulado.nombre}' (ID: ${id}).`,
      });

      return tipoGastoAnulado;
    });
  }

  async activar(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const tipoGasto = await tx.tipoGasto.findUnique({ where: { id } });
      if (!tipoGasto) {
        throw new NotFoundException(`No se encontró el tipo de gasto solicitado con el ID ${id}.`);
      }

      if (!tipoGasto.anulado) {
        throw new BadRequestException(`El tipo de gasto '${tipoGasto.nombre}' ya se encuentra activo.`);
      }

      const tipoGastoActivado = await tx.tipoGasto.update({
        where: { id },
        data: { anulado: false },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ACTIVAR_TIPO_GASTO',
        modulo: 'TiposGasto',
        descripcion: `Se reactivó el tipo de gasto '${tipoGastoActivado.nombre}' (ID: ${id}).`,
      });

      return tipoGastoActivado;
    });
  }
}
