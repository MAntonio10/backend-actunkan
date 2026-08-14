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
import { ContextoSesion, SesionesService } from './sesiones.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usuariosService: UsuariosService,
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly jwtService: JwtService,
    private readonly sesionesService: SesionesService,
  ) {}

  /**
   * Vida del token de acceso. Corta a propósito: el JWT no es revocable, así que
   * se compensa expirando pronto y renovándolo con el refresh token.
   * El formato es el de `ms` (ej. '15m', '1h').
   */
  private get expiracionAcceso(): `${number}${'s' | 'm' | 'h' | 'd'}` {
    return (process.env.JWT_ACCESS_EXPIRA || '30m') as `${number}${'s' | 'm' | 'h' | 'd'}`;
  }

  private async firmarAcceso(usuario: { id: number; correo: string; idPuesto: number }) {
    return this.jwtService.signAsync(
      { sub: usuario.id, email: usuario.correo, idPuesto: usuario.idPuesto },
      { expiresIn: this.expiracionAcceso },
    );
  }

  async login(loginDto: LoginDto, ctx: ContextoSesion = {}) {
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

    const token = await this.firmarAcceso(usuario);

    // El refresh es lo que sostiene la sesión larga y, a diferencia del token de
    // acceso, se puede revocar individualmente sin afectar a nadie más.
    const { refreshToken, sesion } = await this.sesionesService.crear(
      usuario.id,
      loginDto.recordarme === true,
      ctx,
    );

    const { contrasena, ...usuarioSinContrasena } = usuario;

    this.logger.log(`Usuario autenticado exitosamente: ${usuario.correo} (ID: ${usuario.id})`);

    // Registrar en Bitácora
    await BitacoraService.registrarEnTransaccion(this.prisma, {
      idUsuario: usuario.id,
      usuarioNombre: usuario.nombre,
      accion: 'INICIO_SESION',
      modulo: 'Auth',
      descripcion: `Inicio de sesion exitoso para el usuario '${usuario.nombre}' (${usuario.correo}).`,
    });

    return {
      access_token: token,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.expiracionAcceso,
      refresh_expira: sesion.fechaExpiracion,
      usuario: usuarioSinContrasena,
    };
  }

  /**
   * Renueva el token de acceso a partir del refresh, que se rota en cada uso.
   * Es lo que permite tener sesiones de 30 días sin que un token robado sirva
   * indefinidamente: basta revocar esa sesión.
   */
  async refrescar(refreshToken: string, ctx: ContextoSesion = {}) {
    const { refreshToken: nuevoRefresh, sesion, usuario } = await this.sesionesService.rotar(
      refreshToken,
      ctx,
    );

    const accessToken = await this.firmarAcceso(usuario);

    return {
      access_token: accessToken,
      refresh_token: nuevoRefresh,
      token_type: 'Bearer',
      expires_in: this.expiracionAcceso,
      refresh_expira: sesion.fechaExpiracion,
    };
  }

  /** Cierra la sesión indicada. Las demás sesiones del usuario siguen activas. */
  async logout(refreshToken: string, ejecutor?: { id: number; nombre?: string }) {
    const resultado = await this.sesionesService.revocarUna(refreshToken);

    if (resultado.revocadas > 0) {
      await BitacoraService.registrarEnTransaccion(this.prisma, {
        idUsuario: ejecutor?.id ?? resultado.idUsuario,
        usuarioNombre: ejecutor?.nombre,
        accion: 'CIERRE_SESION',
        modulo: 'Auth',
        descripcion: 'Cierre de sesión: se revocó el refresh token de esa sesión.',
      });
    }

    return { mensaje: 'Sesión cerrada.', sesionesCerradas: resultado.revocadas };
  }

  /** Cierra todas las sesiones del usuario autenticado (no afecta a otros usuarios). */
  async logoutTodas(idUsuario: number, nombre?: string) {
    const resultado = await this.sesionesService.revocarTodas(
      idUsuario,
      'Cierre de todas las sesiones solicitado por el usuario',
    );

    await BitacoraService.registrarEnTransaccion(this.prisma, {
      idUsuario,
      usuarioNombre: nombre,
      accion: 'CIERRE_SESION_TOTAL',
      modulo: 'Auth',
      descripcion: `Se cerraron ${resultado.revocadas} sesión(es) del usuario.`,
    });

    return { mensaje: 'Se cerraron todas las sesiones.', sesionesCerradas: resultado.revocadas };
  }

  listarSesiones(idUsuario: number) {
    return this.sesionesService.listarActivas(idUsuario);
  }

  cerrarSesionPorId(idUsuario: number, idSesion: number) {
    return this.sesionesService.revocarPorId(idUsuario, idSesion);
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

    // Cambiar la contraseña debe expulsar cualquier sesión previa: si alguien más
    // tenía acceso, el restablecimiento no sirve de nada si sus tokens siguen vivos.
    // Solo afecta a este usuario.
    const cerradas = await this.sesionesService.revocarTodas(
      usuario.id,
      'Restablecimiento de contraseña',
    );

    this.logger.log(
      `Contraseña restablecida exitosamente para el usuario: ${usuario.correo}. ` +
        `Sesiones cerradas: ${cerradas.revocadas}.`,
    );

    return {
      mensaje: 'La contraseña ha sido restablecida exitosamente. Ya puede iniciar sesión con su nueva contraseña.',
    };
  }
}
