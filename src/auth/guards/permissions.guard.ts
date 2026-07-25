import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PERMISSION_KEY,
  PermissionRequirement,
} from '../../common/decorators/require-permission.decorator';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredPermission = this.reflector.getAllAndOverride<PermissionRequirement>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const usuario = request.user;

    if (!usuario || !usuario.id) {
      throw new UnauthorizedException(
        'No se pudo verificar la identidad del usuario para validar permisos. Asegúrese de que JwtAuthGuard preceda a este guard.',
      );
    }

    const permisoAsignado = await this.prisma.permisos.findFirst({
      where: {
        idUsuario: usuario.id,
        moduloAccion: {
          modulo: {
            nombre: requiredPermission.modulo,
            anulado: false,
          },
          accion: {
            nombre: requiredPermission.accion,
          },
        },
      },
    });

    if (!permisoAsignado) {
      throw new ForbiddenException(
        `Acceso denegado: El usuario '${usuario.nombre}' no cuenta con el permiso requerido para realizar la acción '${requiredPermission.accion}' en el módulo '${requiredPermission.modulo}'.`,
      );
    }

    return true;
  }
}
