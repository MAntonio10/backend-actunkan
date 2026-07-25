import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
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

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException(
        'No se proporcionó la cabecera "Authorization" con el token de acceso Bearer.',
      );
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException(
        'Formato de token no válido. Debe ser "Bearer <token>".',
      );
    }

    try {
      const payload = await this.jwtService.verifyAsync(token);

      const usuario = await this.prisma.usuario.findUnique({
        where: { id: payload.sub },
        select: { id: true, correo: true, nombre: true, idPuesto: true, anulado: true },
      });

      if (!usuario) {
        throw new UnauthorizedException(
          `El usuario asociado al token (ID: ${payload.sub}) ya no existe en el sistema.`,
        );
      }

      if (usuario.anulado) {
        throw new UnauthorizedException(
          `El usuario '${usuario.nombre}' (${usuario.correo}) ha sido desactivado/anulado en el sistema. Acceso denegado.`,
        );
      }

      request.user = usuario;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException(
        'El token de autenticación provisto es inválido o ha expirado. Por favor, vuelva a iniciar sesión.',
      );
    }
  }
}
