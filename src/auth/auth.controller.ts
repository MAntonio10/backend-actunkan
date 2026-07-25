import { Body, Controller, Get, Post, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SolicitarCodigoDto } from './dto/solicitar-codigo.dto';
import { ValidarCodigoDto } from './dto/validar-codigo.dto';
import { RestablecerContrasenaDto } from './dto/restablecer-contrasena.dto';
import { Public } from '../common/decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Get('me')
  getProfile(@Request() req: any) {
    return this.authService.getProfile(req.user.sub ?? req.user.id);
  }

  @Public()
  @Post('solicitar-codigo-restablecimiento')
  solicitarCodigoRestablecimiento(@Body() dto: SolicitarCodigoDto) {
    return this.authService.solicitarCodigoRestablecimiento(dto);
  }

  @Public()
  @Post('validar-codigo-restablecimiento')
  validarCodigoRestablecimiento(@Body() dto: ValidarCodigoDto) {
    return this.authService.validarCodigoRestablecimiento(dto);
  }

  @Public()
  @Post('restablecer-contrasena')
  restablecerContrasena(@Body() dto: RestablecerContrasenaDto) {
    return this.authService.restablecerContrasena(dto);
  }
}
