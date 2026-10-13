import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueryBitacoraDto } from './dto/query-bitacora.dto';
import { getFechaUTC6 } from '../common/utils/date.util';
import {
  PAGINACION_BITACORA,
  construirRespuestaPaginada,
  resolverPaginacion,
} from '../common/utils/paginacion.util';

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
  static async registrarEnTransaccion(tx: any, datos: RegistrarBitacoraParams) {
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
   * Listado de auditoría paginado, del más reciente al más antiguo salvo que se
   * pida al revés.
   *
   * Antes topaba en 100 registros con un `take` suelto y no había forma de pedir
   * los siguientes: los más viejos quedaban fuera de alcance por la API. Es la
   * tabla que más crece del sistema, así que el listado devuelve una página y el
   * `total` del filtro completo.
   */
  async findAll(queryDto?: QueryBitacoraDto) {
    const { buscar, idUsuario, modulo, accion, fechaInicio, fechaFin } =
      queryDto || {};
    const orden = queryDto?.orden === 'asc' ? 'asc' : 'desc';
    const paginacion = resolverPaginacion(queryDto, PAGINACION_BITACORA);

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

    // Los mismos campos que el buscador mostraba en pantalla, para que no deje de
    // encontrar nada al mudarse al servidor. Convive con los filtros de arriba:
    // `?modulo=Cajas&buscar=anular` exige las dos cosas, no una u otra.
    if (buscar) {
      where.OR = [
        { descripcion: { contains: buscar } },
        { accion: { contains: buscar } },
        { modulo: { contains: buscar } },
        { usuarioNombre: { contains: buscar } },
        { usuario: { correo: { contains: buscar } } },
      ];
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

    const [datos, total] = await Promise.all([
      this.prisma.bitacora.findMany({
        where,
        // El desempate por `id` importa especialmente aquí: la bitácora escribe
        // varias filas en el mismo segundo y SQL Server resuelve `skip`/`take` con
        // OFFSET..FETCH, que sobre una clave repetida no garantiza un orden estable
        // entre páginas: un registro podría salir dos veces o no salir nunca.
        // El desempate va en el MISMO sentido que la fecha: con `asc` un `id: 'desc'`
        // fijo partiría cada segundo repetido por la mitad al revés del resto.
        orderBy: [{ fecha: orden }, { id: orden }],
        skip: paginacion.skip,
        take: paginacion.take,
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
      }),
      this.prisma.bitacora.count({ where }),
    ]);

    return construirRespuestaPaginada(datos, total, paginacion);
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
      throw new NotFoundException(
        `No se encontró el registro de bitácora con ID ${id}.`,
      );
    }

    return registro;
  }
}
