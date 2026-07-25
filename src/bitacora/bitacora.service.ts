import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueryBitacoraDto } from './dto/query-bitacora.dto';
import { getFechaUTC6 } from '../common/utils/date.util';

export interface RegistrarBitacoraParams {
  idUsuario?: number;
  usuarioNombre?: string;
  accion: string;
  modulo: string;
  descripcion: string;
}

@Injectable()
export class BitacoraService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Helper transaccional reutilizable para registrar en la Bitácora dentro de una transacción Prisma.
   */
  static async registrarEnTransaccion(
    tx: any,
    datos: RegistrarBitacoraParams,
  ) {
    return tx.bitacora.create({
      data: {
        idUsuario: datos.idUsuario ?? null,
        usuarioNombre: datos.usuarioNombre ?? null,
        accion: datos.accion,
        modulo: datos.modulo,
        descripcion: datos.descripcion,
        fecha: getFechaUTC6(),
      },
    });
  }

  /**
   * Registra una acción en la Bitácora.
   */
  async registrar(datos: RegistrarBitacoraParams) {
    return this.prisma.bitacora.create({
      data: {
        idUsuario: datos.idUsuario ?? null,
        usuarioNombre: datos.usuarioNombre ?? null,
        accion: datos.accion,
        modulo: datos.modulo,
        descripcion: datos.descripcion,
        fecha: getFechaUTC6(),
      },
    });
  }

  /**
   * Obtiene la lista de registros de la bitácora ordenados descendentemente con filtros opcionales.
   */
  async findAll(queryDto?: QueryBitacoraDto) {
    const { idUsuario, modulo, accion, fechaInicio, fechaFin, limite } = queryDto || {};

    const where: any = {};

    if (idUsuario) {
      where.idUsuario = idUsuario;
    }

    if (modulo) {
      where.modulo = { contains: modulo };
    }

    if (accion) {
      where.accion = { contains: accion };
    }

    if (fechaInicio || fechaFin) {
      where.fecha = {};
      if (fechaInicio) {
        where.fecha.gte = new Date(fechaInicio);
      }
      if (fechaFin) {
        where.fecha.lte = new Date(fechaFin);
      }
    }

    return this.prisma.bitacora.findMany({
      where,
      orderBy: { fecha: 'desc' },
      take: limite ? Number(limite) : 100,
      include: {
        usuario: {
          select: {
            id: true,
            nombre: true,
            correo: true,
            puesto: {
              select: {
                id: true,
                nombre: true,
              },
            },
          },
        },
      },
    });
  }

  /**
   * Obtiene un registro de la bitácora por su ID.
   */
  async findOne(id: number) {
    const registro = await this.prisma.bitacora.findUnique({
      where: { id },
      include: {
        usuario: {
          select: {
            id: true,
            nombre: true,
            correo: true,
            puesto: {
              select: {
                id: true,
                nombre: true,
              },
            },
          },
        },
      },
    });

    if (!registro) {
      throw new NotFoundException(`No se encontró el registro de bitácora con ID ${id}.`);
    }

    return registro;
  }
}
