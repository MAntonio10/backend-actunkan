import {
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsuariosService } from '../usuarios/usuarios.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usuariosService: UsuariosService,
    private readonly jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto) {
    let usuario;
    try {
      usuario = await this.usuariosService.findByCorreo(loginDto.correo);
    } catch {
      throw new UnauthorizedException(
        'Las credenciales ingresadas son incorrectas. Verifique su correo electrónico y contraseña.',
      );
    }

    if (usuario.anulado) {
      throw new UnauthorizedException(
        `El usuario '${usuario.nombre}' (${usuario.correo}) se encuentra deshabilitado/anulado en el sistema.`,
      );
    }

    const esContrasenaValida = await bcrypt.compare(
      loginDto.contrasena,
      usuario.contrasena,
    );

    if (!esContrasenaValida) {
      throw new UnauthorizedException(
        'Las credenciales ingresadas son incorrectas. Verifique su correo electrónico y contraseña.',
      );
    }

    const payload = {
      sub: usuario.id,
      email: usuario.correo,
      idPuesto: usuario.idPuesto,
    };

    const token = await this.jwtService.signAsync(payload);

    const { contrasena, ...usuarioSinContrasena } = usuario;

    this.logger.log(`Usuario autenticado exitosamente: ${usuario.correo} (ID: ${usuario.id})`);

    return {
      access_token: token,
      token_type: 'Bearer',
      usuario: usuarioSinContrasena,
    };
  }

  async getProfile(usuarioId: number) {
    return this.usuariosService.findOne(usuarioId);
  }
}
