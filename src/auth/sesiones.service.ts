import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { getFechaUTC6 } from '../common/utils/date.util';

export interface ContextoSesion {
  ip?: string;
  dispositivo?: string;
}

/** Duración del refresh según haya marcado o no "Recordarme". */
const DIAS_CON_RECORDARME = 30;
const HORAS_SIN_RECORDARME = 24;

@Injectable()
export class SesionesService {
  private readonly logger = new Logger(SesionesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * El refresh token es una cadena aleatoria opaca, no un JWT: no necesita ser
   * autodescriptivo porque siempre se valida contra la base de datos.
   */
  private generarToken(): string {
    return randomBytes(48).toString('base64url');
  }

  /**
   * Se almacena solo el hash. SHA-256 basta —y es lo correcto— porque el token
   * tiene 384 bits de entropía: bcrypt está pensado para secretos débiles como
   * contraseñas, aquí solo añadiría latencia en cada petición de refresco.
   */
  private hashear(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private calcularExpiracion(recordarme: boolean, desde: Date): Date {
    const ms = recordarme
      ? DIAS_CON_RECORDARME * 24 * 60 * 60 * 1000
      : HORAS_SIN_RECORDARME * 60 * 60 * 1000;
    return new Date(desde.getTime() + ms);
  }

  /** Crea una sesión nueva y devuelve el refresh token en claro (única vez que se ve). */
  async crear(idUsuario: number, recordarme: boolean, ctx: ContextoSesion = {}) {
    const token = this.generarToken();
    const ahora = getFechaUTC6();

    const sesion = await this.prisma.sesionRefresh.create({
      data: {
        idUsuario,
        tokenHash: this.hashear(token),
        fechaCreacion: ahora,
        fechaExpiracion: this.calcularExpiracion(recordarme, ahora),
        ip: ctx.ip?.slice(0, 64),
        dispositivo: ctx.dispositivo?.slice(0, 255),
      },
    });

    return { refreshToken: token, sesion };
  }

  /**
   * Valida y **rota** el refresh token: el anterior se revoca y se emite uno nuevo.
   *
   * Si llega un token ya revocado, se asume robo —alguien está reusando uno viejo—
   * y se cierran todas las sesiones de ese usuario. Es la respuesta correcta a una
   * reutilización: no afecta a otros usuarios, solo al comprometido.
   */
  async rotar(tokenRecibido: string, ctx: ContextoSesion = {}) {
    const hash = this.hashear(tokenRecibido);

    const sesion = await this.prisma.sesionRefresh.findUnique({
      where: { tokenHash: hash },
      include: { usuario: true },
    });

    if (!sesion) {
      throw new UnauthorizedException('La sesión no es válida. Vuelva a iniciar sesión.');
    }

    if (sesion.revocada) {
      await this.revocarTodas(
        sesion.idUsuario,
        'Reutilización de un refresh token ya revocado (posible robo)',
      );

      await BitacoraService.registrarEnTransaccion(this.prisma, {
        idUsuario: sesion.idUsuario,
        usuarioNombre: sesion.usuario.nombre,
        accion: 'ALERTA_SESION',
        modulo: 'Auth',
        descripcion:
          `Se reutilizó un refresh token ya revocado del usuario '${sesion.usuario.nombre}'. ` +
          'Se cerraron todas sus sesiones por precaución.',
      });

      this.logger.warn(
        `Reutilización de refresh token revocado (usuario ${sesion.idUsuario}). Sesiones cerradas.`,
      );

      throw new UnauthorizedException(
        'La sesión fue revocada. Por seguridad se cerraron todas las sesiones; vuelva a iniciar sesión.',
      );
    }

    const ahora = getFechaUTC6();

    if (sesion.fechaExpiracion <= ahora) {
      throw new UnauthorizedException('La sesión expiró. Vuelva a iniciar sesión.');
    }

    if (sesion.usuario.anulado) {
      throw new UnauthorizedException('El usuario se encuentra deshabilitado.');
    }

    // Rotación: se revoca la anterior y se emite otra conservando la expiración original,
    // para que refrescar no alargue la sesión de forma indefinida.
    const nuevoToken = this.generarToken();

    const [, nueva] = await this.prisma.$transaction([
      this.prisma.sesionRefresh.update({
        where: { id: sesion.id },
        data: { revocada: true, motivoRevocacion: 'Rotada al refrescar', fechaUltimoUso: ahora },
      }),
      this.prisma.sesionRefresh.create({
        data: {
          idUsuario: sesion.idUsuario,
          tokenHash: this.hashear(nuevoToken),
          fechaCreacion: ahora,
          fechaExpiracion: sesion.fechaExpiracion,
          ip: ctx.ip?.slice(0, 64) ?? sesion.ip,
          dispositivo: ctx.dispositivo?.slice(0, 255) ?? sesion.dispositivo,
        },
      }),
    ]);

    return { refreshToken: nuevoToken, sesion: nueva, usuario: sesion.usuario };
  }

  /** Cierra una sesión concreta. Las demás del usuario siguen activas. */
  async revocarUna(tokenRecibido: string, motivo = 'Cierre de sesión') {
    const hash = this.hashear(tokenRecibido);
    const sesion = await this.prisma.sesionRefresh.findUnique({ where: { tokenHash: hash } });

    if (!sesion || sesion.revocada) {
      return { revocadas: 0 };
    }

    await this.prisma.sesionRefresh.update({
      where: { id: sesion.id },
      data: { revocada: true, motivoRevocacion: motivo, fechaUltimoUso: getFechaUTC6() },
    });

    return { revocadas: 1, idUsuario: sesion.idUsuario };
  }

  /** Cierra todas las sesiones de UN usuario. No toca las de nadie más. */
  async revocarTodas(idUsuario: number, motivo: string) {
    const resultado = await this.prisma.sesionRefresh.updateMany({
      where: { idUsuario, revocada: false },
      data: { revocada: true, motivoRevocacion: motivo.slice(0, 120) },
    });

    return { revocadas: resultado.count };
  }

  /** Sesiones activas del usuario, para poder cerrar una en concreto. */
  async listarActivas(idUsuario: number) {
    return this.prisma.sesionRefresh.findMany({
      where: { idUsuario, revocada: false, fechaExpiracion: { gt: getFechaUTC6() } },
      select: {
        id: true,
        fechaCreacion: true,
        fechaExpiracion: true,
        fechaUltimoUso: true,
        ip: true,
        dispositivo: true,
      },
      orderBy: { fechaCreacion: 'desc' },
    });
  }

  /** Cierra una sesión por id, verificando que pertenezca al usuario que lo pide. */
  async revocarPorId(idUsuario: number, idSesion: number) {
    const resultado = await this.prisma.sesionRefresh.updateMany({
      where: { id: idSesion, idUsuario, revocada: false },
      data: { revocada: true, motivoRevocacion: 'Cerrada por el usuario' },
    });

    if (resultado.count === 0) {
      throw new UnauthorizedException('La sesión indicada no existe o ya estaba cerrada.');
    }

    return { revocadas: resultado.count };
  }
}
