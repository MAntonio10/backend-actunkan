import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Request,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SolicitarCodigoDto } from './dto/solicitar-codigo.dto';
import { ValidarCodigoDto } from './dto/validar-codigo.dto';
import { RestablecerContrasenaDto } from './dto/restablecer-contrasena.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { Public } from '../common/decorators/public.decorator';
import { ContextoSesion } from './sesiones.service';

/**
 * Las rutas públicas de este controlador son el blanco natural de fuerza bruta,
 * así que llevan límites más estrictos que el resto de la API
 * (ver ThrottlerModule en app.module.ts).
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Se guarda con la sesión para que el usuario reconozca desde dónde se inició. */
  private contexto(req: any): ContextoSesion {
    return {
      ip: req.ip ?? req.socket?.remoteAddress,
      dispositivo: req.headers['user-agent'],
    };
  }

  /** 10 intentos por minuto y por IP: suficiente para un humano, inviable para fuerza bruta. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() loginDto: LoginDto, @Request() req: any) {
    return this.authService.login(loginDto, this.contexto(req));
  }

  /**
   * Renueva el token de acceso. El refresh se rota en cada uso: el anterior queda
   * revocado, de modo que reutilizarlo delata un robo y cierra las sesiones del usuario.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refrescar(@Body() dto: RefreshTokenDto, @Request() req: any) {
    return this.authService.refrescar(dto.refresh_token, this.contexto(req));
  }

  /** Cierra únicamente esta sesión; las demás del usuario siguen activas. */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@Body() dto: RefreshTokenDto, @Request() req: any) {
    const usuario = req.user;
    return this.authService.logout(
      dto.refresh_token,
      usuario ? { id: usuario.id, nombre: usuario.nombre } : undefined,
    );
  }

  /** Cierra todas las sesiones del usuario autenticado. No afecta a otros usuarios. */
  @HttpCode(HttpStatus.OK)
  @Post('logout-todas')
  logoutTodas(@Request() req: any) {
    return this.authService.logoutTodas(req.user.sub ?? req.user.id, req.user.nombre);
  }

  /** Sesiones activas propias, para poder cerrar una en concreto. */
  @Get('sesiones')
  sesiones(@Request() req: any) {
    return this.authService.listarSesiones(req.user.sub ?? req.user.id);
  }

  @Delete('sesiones/:id')
  cerrarSesion(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.authService.cerrarSesionPorId(req.user.sub ?? req.user.id, id);
  }

  @Get('me')
  getProfile(@Request() req: any) {
    return this.authService.getProfile(req.user.sub ?? req.user.id);
  }

  /** Envía correo: se limita a 5 por hora para no habilitar spam contra terceros. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('solicitar-codigo-restablecimiento')
  solicitarCodigoRestablecimiento(@Body() dto: SolicitarCodigoDto) {
    return this.authService.solicitarCodigoRestablecimiento(dto);
  }

  /** El código es de 6 dígitos: sin límite, se adivina por fuerza bruta en minutos. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('validar-codigo-restablecimiento')
  validarCodigoRestablecimiento(@Body() dto: ValidarCodigoDto) {
    return this.authService.validarCodigoRestablecimiento(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('restablecer-contrasena')
  restablecerContrasena(@Body() dto: RestablecerContrasenaDto) {
    return this.authService.restablecerContrasena(dto);
  }
}
