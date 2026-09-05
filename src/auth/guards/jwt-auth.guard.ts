import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { PERMITE_USUARIO_ANULADO_KEY } from '../../common/decorators/permite-usuario-anulado.decorator';
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

      // Sincronizar lo ya vendido es lo único que sobrevive a una baja, y solo
      // en los handlers que lo declaran. Ver el decorador para el porqué.
      const permiteAnulado = this.reflector.getAllAndOverride<boolean>(
        PERMITE_USUARIO_ANULADO_KEY,
        [context.getHandler(), context.getClass()],
      );

      if (usuario.anulado && !permiteAnulado) {
        throw new UnauthorizedException(
          `El usuario '${usuario.nombre}' (${usuario.correo}) ha sido desactivado/anulado en el sistema. Acceso denegado.`,
        );
      }

      /**
       * Un token emitido para un usuario anulado viene marcado. Si no lo
       * rechazáramos acá, bastaría refrescar tras la baja para recuperar acceso
       * completo al sistema y la baja no serviría de nada: el token es válido y
       * el usuario podría volver a activarse mientras tanto.
       */
      if (payload.soloSincronizacion && !permiteAnulado) {
        throw new UnauthorizedException(
          'Este token solo permite sincronizar ventas offline pendientes. Vuelva a iniciar sesión.',
        );
      }

      request.user = { ...usuario, soloSincronizacion: Boolean(payload.soloSincronizacion) };
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
