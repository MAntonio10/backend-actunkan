import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { AssignPermisosDto } from './dto/assign-permisos.dto';
import { getFechaUTC6 } from '../common/utils/date.util';

export interface UsuarioEjecutor {
  id: number;
  email?: string;
}

@Injectable()
export class UsuariosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUsuarioDto, ejecutor?: UsuarioEjecutor) {
    return this.prisma.$transaction(async (tx) => {
      const existeCorreo = await tx.usuario.findUnique({
        where: { correo: dto.correo },
      });

      if (existeCorreo) {
        throw new ConflictException(
          `El correo electrónico '${dto.correo}' ya está registrado por otro usuario.`,
        );
      }

      const puesto = await tx.puestos.findUnique({
        where: { id: dto.idPuesto },
      });

      if (!puesto) {
        throw new NotFoundException(
          `No se puede crear el usuario. El puesto especificado (ID: ${dto.idPuesto}) no existe en el sistema.`,
        );
      }

      if (puesto.anulado) {
        throw new BadRequestException(
          `No se puede asignar el puesto '${puesto.nombre}' porque se encuentra deshabilitado/anulado.`,
        );
      }

      const salt = await bcrypt.genSalt(10);
      const contrasenaEncriptada = await bcrypt.hash(dto.contrasena, salt);
      const ahora = getFechaUTC6();

      const usuario = await tx.usuario.create({
        data: {
          nombre: dto.nombre,
          correo: dto.correo,
          contrasena: contrasenaEncriptada,
          idPuesto: dto.idPuesto,
          telefono: dto.telefono,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        },
        include: {
          puesto: true,
        },
      });

      // Obtener nombre del ejecutor si existe
      let nombreEjecutor = ejecutor?.email;
      if (ejecutor?.id) {
        const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
        if (uEj) nombreEjecutor = uEj.nombre;
      }

      // Registrar en Bitácora
      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: nombreEjecutor,
        accion: 'CREAR_USUARIO',
        modulo: 'Usuarios',
        descripcion: `Se creo el nuevo usuario '${usuario.nombre}' (${usuario.correo}) asignado al puesto '${puesto.nombre}'.`,
      });

      const { contrasena, ...usuarioSinContrasena } = usuario;
      return usuarioSinContrasena;
    });
  }

  async findAll(incluirAnulados = false) {
    const usuarios = await this.prisma.usuario.findMany({
      where: incluirAnulados ? {} : { anulado: false },
      include: {
        puesto: true,
        permiso: {
          include: {
            moduloAccion: {
              include: {
                modulo: true,
                accion: true,
              },
            },
          },
        },
      },
      orderBy: { nombre: 'asc' },
    });

    return usuarios.map(({ contrasena, ...user }) => user);
  }

  async findOne(id: number) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id },
      include: {
        puesto: true,
        permiso: {
          include: {
            moduloAccion: {
              include: {
                modulo: true,
                accion: true,
              },
            },
          },
        },
      },
    });

    if (!usuario) {
      throw new NotFoundException(`No se encontró ningún usuario solicitado con el ID ${id}.`);
    }

    const { contrasena, ...usuarioSinContrasena } = usuario;
    return usuarioSinContrasena;
  }

  async findByCorreo(correo: string) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { correo },
      include: {
        puesto: true,
        permiso: {
          include: {
            moduloAccion: {
              include: {
                modulo: true,
                accion: true,
              },
            },
          },
        },
      },
    });

    if (!usuario) {
      throw new NotFoundException(
        `No se encontró ningún usuario registrado con el correo '${correo}'.`,
      );
    }

    return usuario;
  }

  async update(id: number, dto: UpdateUsuarioDto, ejecutor?: UsuarioEjecutor) {
    if (ejecutor?.id && id === ejecutor.id && dto.anulado === true) {
      throw new BadRequestException(
        'No puede desactivar ni anular su propia cuenta de usuario.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const usuarioExistente = await tx.usuario.findUnique({
        where: { id },
      });

      if (!usuarioExistente) {
        throw new NotFoundException(`No se encontró el usuario con ID ${id} para actualizar.`);
      }

      if (dto.correo && dto.correo !== usuarioExistente.correo) {
        const otroUsuario = await tx.usuario.findUnique({
          where: { correo: dto.correo },
        });
        if (otroUsuario && otroUsuario.id !== id) {
          throw new ConflictException(
            `El correo '${dto.correo}' ya está en uso por otro usuario.`,
          );
        }
      }

      if (dto.idPuesto) {
        const puesto = await tx.puestos.findUnique({
          where: { id: dto.idPuesto },
        });
        if (!puesto) {
          throw new NotFoundException(
            `El puesto especificado (ID: ${dto.idPuesto}) no existe en el sistema.`,
          );
        }
        if (puesto.anulado) {
          throw new BadRequestException(
            `No se puede asignar el puesto '${puesto.nombre}' (ID: ${puesto.id}) ya que está anulado.`,
          );
        }
      }

      let contrasenaEncriptada = usuarioExistente.contrasena;
      if (dto.contrasena) {
        const salt = await bcrypt.genSalt(10);
        contrasenaEncriptada = await bcrypt.hash(dto.contrasena, salt);
      }

      const usuarioActualizado = await tx.usuario.update({
        where: { id },
        data: {
          nombre: dto.nombre ?? usuarioExistente.nombre,
          correo: dto.correo ?? usuarioExistente.correo,
          contrasena: contrasenaEncriptada,
          idPuesto: dto.idPuesto ?? usuarioExistente.idPuesto,
          telefono: dto.telefono ?? usuarioExistente.telefono,
          anulado: dto.anulado ?? usuarioExistente.anulado,
          fechaActualizacion: getFechaUTC6(),
        },
        include: {
          puesto: true,
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
        accion: 'EDITAR_USUARIO',
        modulo: 'Usuarios',
        descripcion: `Se actualizaron los datos del usuario '${usuarioActualizado.nombre}' (${usuarioActualizado.correo}).`,
      });

      const { contrasena, ...resultado } = usuarioActualizado;
      return resultado;
    });
  }

  async remove(id: number, ejecutor?: UsuarioEjecutor) {
    if (ejecutor?.id && id === ejecutor.id) {
      throw new BadRequestException(
        'No puede desactivar ni anular su propia cuenta de usuario.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const usuarioExistente = await tx.usuario.findUnique({
        where: { id },
      });

      if (!usuarioExistente) {
        throw new NotFoundException(`No se encontró ningún usuario solicitado con el ID ${id}.`);
      }

      const usuarioAnulado = await tx.usuario.update({
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
        accion: 'ANULAR_USUARIO',
        modulo: 'Usuarios',
        descripcion: `Se anuló/deshabilitó al usuario '${usuarioAnulado.nombre}' (ID: ${usuarioAnulado.id}).`,
      });

      const { contrasena, ...resultado } = usuarioAnulado;
      return resultado;
    });
  }

  async activar(id: number, ejecutor?: UsuarioEjecutor) {
    return this.prisma.$transaction(async (tx) => {
      const usuarioExistente = await tx.usuario.findUnique({
        where: { id },
        include: { puesto: true },
      });

      if (!usuarioExistente) {
        throw new NotFoundException(`No se encontró ningún usuario solicitado con el ID ${id}.`);
      }

      if (!usuarioExistente.anulado) {
        throw new BadRequestException(
          `El usuario '${usuarioExistente.nombre}' ya se encuentra activo en el sistema.`,
        );
      }

      if (usuarioExistente.puesto.anulado) {
        throw new BadRequestException(
          `No se puede activar el usuario '${usuarioExistente.nombre}' porque el puesto asignado ('${usuarioExistente.puesto.nombre}') se encuentra anulado/deshabilitado.`,
        );
      }

      const usuarioActivado = await tx.usuario.update({
        where: { id },
        data: {
          anulado: false,
          fechaActualizacion: getFechaUTC6(),
        },
        include: {
          puesto: true,
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
        accion: 'ACTIVAR_USUARIO',
        modulo: 'Usuarios',
        descripcion: `Se reactivó al usuario '${usuarioActivado.nombre}' (ID: ${usuarioActivado.id}).`,
      });

      const { contrasena, ...resultado } = usuarioActivado;
      return resultado;
    });
  }

  async assignPermisos(idUsuario: number, dto: AssignPermisosDto, ejecutor?: UsuarioEjecutor) {
    if (ejecutor?.id && idUsuario === ejecutor.id) {
      throw new BadRequestException(
        'No puede modificar ni revocarse sus propios permisos de usuario.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const usuario = await tx.usuario.findUnique({
        where: { id: idUsuario },
      });

      if (!usuario) {
        throw new NotFoundException(`No se encontró ningún usuario solicitado con el ID ${idUsuario}.`);
      }

      const moduloAcciones = await tx.moduloAccion.findMany({
        where: {
          id: { in: dto.idsModuloAccion },
        },
      });

      if (moduloAcciones.length !== dto.idsModuloAccion.length) {
        const encontradosIds = moduloAcciones.map((ma) => ma.id);
        const faltantes = dto.idsModuloAccion.filter(
          (id) => !encontradosIds.includes(id),
        );
        throw new NotFoundException(
          `No se encontraron los siguientes IDs de MóduloAcción solicitados: [${faltantes.join(', ')}].`,
        );
      }

      await tx.permisos.deleteMany({
        where: { idUsuario },
      });

      if (dto.idsModuloAccion.length > 0) {
        await tx.permisos.createMany({
          data: dto.idsModuloAccion.map((idModuloAccion) => ({
            idUsuario,
            idModuloAccion,
          })),
        });
      }

      let nombreEjecutor = ejecutor?.email;
      if (ejecutor?.id) {
        const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
        if (uEj) nombreEjecutor = uEj.nombre;
      }

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: nombreEjecutor,
        accion: 'ASIGNAR_PERMISOS',
        modulo: 'Usuarios',
        descripcion: `Se actualizaron los permisos asignados al usuario '${usuario.nombre}' (ID: ${usuario.id}). Permisos asignados: ${dto.idsModuloAccion.length}.`,
      });

      const usuarioConPermisos = await tx.usuario.findUnique({
        where: { id: idUsuario },
        include: {
          puesto: true,
          permiso: {
            include: {
              moduloAccion: {
                include: {
                  modulo: true,
                  accion: true,
                },
              },
            },
          },
        },
      });

      const { contrasena, ...usuarioSinContrasena } = usuarioConPermisos!;
      return usuarioSinContrasena;
    });
  }
}
