import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsuariosService } from '../usuarios/usuarios.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { LoginDto } from './dto/login.dto';
import { SolicitarCodigoDto } from './dto/solicitar-codigo.dto';
import { ValidarCodigoDto } from './dto/validar-codigo.dto';
import { RestablecerContrasenaDto } from './dto/restablecer-contrasena.dto';
import { getFechaUTC6 } from '../common/utils/date.util';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usuariosService: UsuariosService,
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
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

    const expiresIn = loginDto.recordarme ? '365d' : '24h';
    const token = await this.jwtService.signAsync(payload, { expiresIn });

    const { contrasena, ...usuarioSinContrasena } = usuario;

    this.logger.log(`Usuario autenticado exitosamente: ${usuario.correo} (ID: ${usuario.id})`);

    // Registrar en Bitácora
    await BitacoraService.registrarEnTransaccion(this.prisma, {
      idUsuario: usuario.id,
      usuarioNombre: usuario.nombre,
      accion: 'INICIO_SESION',
      modulo: 'Auth',
      descripcion: `Inicio de sesión exitoso para el usuario '${usuario.nombre}' (${usuario.correo}).`,
    });

    return {
      access_token: token,
      token_type: 'Bearer',
      usuario: usuarioSinContrasena,
    };
  }

  async getProfile(usuarioId: number) {
    return this.usuariosService.findOne(usuarioId);
  }

  async solicitarCodigoRestablecimiento(dto: SolicitarCodigoDto) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { correo: dto.correo },
    });

    if (!usuario) {
      throw new NotFoundException(
        `No existe ningún usuario registrado con el correo '${dto.correo}'.`,
      );
    }

    if (usuario.anulado) {
      throw new BadRequestException(
        `No se puede solicitar el código porque la cuenta de usuario está deshabilitada/anulada.`,
      );
    }

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const ahora = getFechaUTC6();
    const expiracion = new Date(ahora.getTime() + 15 * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuario.id },
        data: {
          codigoRestablecimiento: codigo,
          expiracionCodigo: expiracion,
          fechaActualizacion: ahora,
        },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: usuario.id,
        usuarioNombre: usuario.nombre,
        accion: 'SOLICITAR_CODIGO_RECUPERACION',
        modulo: 'Auth',
        descripcion: `Solicitud de código de verificación de 6 dígitos enviada a '${usuario.correo}'.`,
      });
    });

    await this.mailService.enviarCodigoRestablecimiento(
      usuario.correo,
      usuario.nombre,
      codigo,
    );

    return {
      mensaje: `Se ha enviado un código de verificación de 6 dígitos al correo electrónico '${usuario.correo}'.`,
      expiracionMinutos: 15,
    };
  }

  async validarCodigoRestablecimiento(dto: ValidarCodigoDto) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { correo: dto.correo },
    });

    if (!usuario) {
      throw new NotFoundException(
        `No existe ningún usuario registrado con el correo '${dto.correo}'.`,
      );
    }

    if (usuario.anulado) {
      throw new BadRequestException(
        `La cuenta de usuario especificada está deshabilitada/anulada.`,
      );
    }

    if (!usuario.codigoRestablecimiento || usuario.codigoRestablecimiento !== dto.codigo) {
      throw new BadRequestException(
        `El código de verificación de 6 dígitos ingresado es incorrecto.`,
      );
    }

    const ahora = getFechaUTC6();
    if (!usuario.expiracionCodigo || usuario.expiracionCodigo < ahora) {
      throw new BadRequestException(
        `El código de verificación ha expirado. Por favor, solicite un nuevo código.`,
      );
    }

    return {
      valido: true,
      mensaje: 'El código de verificación es válido.',
    };
  }

  async restablecerContrasena(dto: RestablecerContrasenaDto) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { correo: dto.correo },
    });

    if (!usuario) {
      throw new NotFoundException(
        `No existe ningún usuario registrado con el correo '${dto.correo}'.`,
      );
    }

    if (usuario.anulado) {
      throw new BadRequestException(
        `La cuenta de usuario especificada está deshabilitada/anulada.`,
      );
    }

    if (!usuario.codigoRestablecimiento || usuario.codigoRestablecimiento !== dto.codigo) {
      throw new BadRequestException(
        `El código de verificación de 6 dígitos ingresado es incorrecto.`,
      );
    }

    const ahora = getFechaUTC6();
    if (!usuario.expiracionCodigo || usuario.expiracionCodigo < ahora) {
      throw new BadRequestException(
        `El código de verificación ha expirado. Por favor, solicite un nuevo código.`,
      );
    }

    const salt = await bcrypt.genSalt(10);
    const contrasenaEncriptada = await bcrypt.hash(dto.nuevaContrasena, salt);

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuario.id },
        data: {
          contrasena: contrasenaEncriptada,
          codigoRestablecimiento: null,
          expiracionCodigo: null,
          fechaActualizacion: ahora,
        },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: usuario.id,
        usuarioNombre: usuario.nombre,
        accion: 'RESTABLECER_CONTRASENA',
        modulo: 'Auth',
        descripcion: `El usuario '${usuario.nombre}' (${usuario.correo}) restableció su contraseña de acceso mediante código de verificación.`,
      });
    });

    this.logger.log(`Contraseña restablecida exitosamente para el usuario: ${usuario.correo}`);

    return {
      mensaje: 'La contraseña ha sido restablecida exitosamente. Ya puede iniciar sesión con su nueva contraseña.',
    };
  }
}
