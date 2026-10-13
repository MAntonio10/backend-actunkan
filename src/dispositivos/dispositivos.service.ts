import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createPublicKey } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../common/utils/date.util';
import { RegistrarDispositivoDto } from './dto/registrar-dispositivo.dto';

const MODULO_BITACORA = 'Sincronizacion';

@Injectable()
export class DispositivosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cajasService: CajasService,
  ) {}

  private async obtenerNombreEjecutor(tx: any, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) return ejecutor?.email;
    const usuario = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
    return usuario?.nombre ?? ejecutor.email;
  }

  /**
   * Comprueba que la llave sirva ANTES de guardarla.
   *
   * Una llave ilegible aceptada aquí no falla ahora: falla semanas después, en el
   * torniquete, cuando ya no hay red para corregirla y el visitante está esperando.
   */
  private validarLlave(llavePublica: string) {
    try {
      const llave = createPublicKey({
        key: Buffer.from(llavePublica, 'base64'),
        format: 'der',
        type: 'spki',
      });

      if (llave.asymmetricKeyType !== 'ec') {
        throw new Error('no es una llave de curva elíptica');
      }
    } catch {
      throw new BadRequestException(
        'La llave pública no es una clave ECDSA P-256 válida en formato SPKI.',
      );
    }
  }

  /**
   * Asigna la siguiente serie libre ('D01', 'D02'...).
   *
   * La serie es lo que permite que dos taquillas numeren folios a la vez sin
   * consultarse: al no compartir serie, no pueden chocar de correlativo. Por eso se
   * asigna una sola vez y no se reutiliza aunque el dispositivo se revoque — un
   * folio viejo de esa serie tiene que seguir señalando al equipo que lo emitió.
   */
  private async siguienteSerie(tx: any): Promise<string> {
    const usadas: Array<{ serie: string }> =
      await tx.dispositivoTaquilla.findMany({
        select: { serie: true },
      });

    const numeros = usadas
      .map((d) => Number.parseInt(d.serie.replace(/^D/, ''), 10))
      .filter((n) => Number.isFinite(n));

    const siguiente = (numeros.length ? Math.max(...numeros) : 0) + 1;
    return `D${String(siguiente).padStart(2, '0')}`;
  }

  /**
   * Alta o renovación de llave de una taquilla. Exige conexión por definición: es
   * justo el momento con red que el modo sin conexión necesita haber tenido antes.
   *
   * EXIGE CAJA ABIERTA, y la exige acá y no al subir las ventas.
   * -----------------------------------------------------------
   * Toda venta sin conexión cuadra contra una caja. Sin caja abierta el equipo se
   * armaba igual, el taquillero cobraba el turno entero, y recién al sincronizar el
   * servidor respondía que no había caja a la que asociar el dinero. Para entonces
   * el dinero ya estaba en el cajón y el visitante dentro del parque: no hay forma
   * de deshacerlo, solo de explicarlo.
   *
   * Pedirla al armar el equipo mueve el fallo al único momento donde todavía se
   * puede corregir sin costo —hay red, no se ha cobrado nada— y donde la salida es
   * una acción clara: abrir la caja.
   *
   * Devuelve la caja junto con la serie porque el dispositivo igual la necesita para
   * trabajar, y así no hay un segundo viaje que pueda fallar cuando ya no haya red.
   */
  async registrar(dto: RegistrarDispositivoDto, ejecutor?: EjecutorInfo) {
    this.validarLlave(dto.llavePublica);

    const caja = await this.cajasService.obtenerActual();
    if (!caja) {
      throw new ConflictException({
        codigo: 'SIN_CAJA_ABIERTA',
        message:
          'No hay una caja abierta. Abra la caja del turno antes de habilitar esta ' +
          'taquilla para vender sin conexión: toda venta sin conexión tiene que cuadrar ' +
          'contra una caja, y sin ella el dinero cobrado no se podría sincronizar.',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const existente = await tx.dispositivoTaquilla.findUnique({
        where: { idDispositivo: dto.idDispositivo },
      });

      // Un equipo revocado no vuelve solo: se revoca porque se perdió o se sospecha
      // de él, y dejar que se reactive presentando una llave nueva vaciaría de
      // sentido la revocación.
      if (existente?.revocado) {
        throw new ForbiddenException(
          'Este dispositivo está revocado. Un administrador debe reactivarlo antes de volver a registrarlo.',
        );
      }

      const ahora = getFechaUTC6();
      const nombreEjecutor = await this.obtenerNombreEjecutor(tx, ejecutor);

      const dispositivo = existente
        ? await tx.dispositivoTaquilla.update({
            where: { id: existente.id },
            data: {
              llavePublica: dto.llavePublica,
              nombre: dto.nombre ?? existente.nombre,
              fechaActualizacion: ahora,
              ultimoUso: ahora,
            },
          })
        : await tx.dispositivoTaquilla.create({
            data: {
              idDispositivo: dto.idDispositivo,
              nombre: dto.nombre ?? null,
              serie: await this.siguienteSerie(tx),
              llavePublica: dto.llavePublica,
              idUsuarioRegistro: ejecutor?.id ?? 0,
              fechaCreacion: ahora,
              fechaActualizacion: ahora,
              ultimoUso: ahora,
            },
          });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: nombreEjecutor,
        accion: existente
          ? 'RENOVAR_LLAVE_DISPOSITIVO'
          : 'REGISTRAR_DISPOSITIVO',
        modulo: MODULO_BITACORA,
        descripcion: existente
          ? `Se renovó la llave de la taquilla '${dispositivo.nombre ?? dispositivo.idDispositivo}' (serie ${dispositivo.serie}).`
          : `Se registró la taquilla '${dispositivo.nombre ?? dispositivo.idDispositivo}' con la serie ${dispositivo.serie}.`,
      });

      return {
        id: dispositivo.id,
        idDispositivo: dispositivo.idDispositivo,
        nombre: dispositivo.nombre,
        serie: dispositivo.serie,
        ultimoCorrelativo: dispositivo.ultimoCorrelativo,
        revocado: dispositivo.revocado,
        // La caja del turno, para que el equipo no tenga que pedirla aparte.
        caja: { id: caja.id, fechaCreacion: caja.fechaCreacion },
      };
    });
  }

  /**
   * Listado con los folios de los que nadie respondió.
   *
   * `foliosSinRendir` es la diferencia entre lo que la taquilla numeró y lo que
   * llegó —como ticket o como descarte declarado—. Es la cifra que delata un cobro
   * desviado sin que nadie tenga que sospechar primero: declarar el descarte es
   * voluntario, pero el hueco que deja no declararlo aparece igual.
   */
  async findAll(incluirRevocados = false) {
    const dispositivos = await this.prisma.dispositivoTaquilla.findMany({
      where: incluirRevocados ? {} : { revocado: false },
      select: {
        id: true,
        idDispositivo: true,
        nombre: true,
        serie: true,
        ultimoCorrelativo: true,
        revocado: true,
        fechaCreacion: true,
        ultimoUso: true,
        foliosRendidos: true,
        usuarioRegistro: { select: { id: true, nombre: true } },
      },
      orderBy: [{ serie: 'asc' }],
    });

    return dispositivos.map((d) => ({
      ...d,
      // Nunca negativo: una venta que llega tarde puede rendir un folio anterior al
      // máximo visto, y eso no significa que sobren rendiciones.
      foliosSinRendir: Math.max(0, d.ultimoCorrelativo - d.foliosRendidos),
    }));
  }

  /** Corta la validación de los pases de un equipo perdido, sin borrar lo ya emitido. */
  async revocar(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const dispositivo = await tx.dispositivoTaquilla.findUnique({
        where: { id },
      });
      if (!dispositivo) {
        throw new NotFoundException(
          `No se encontró el dispositivo con el ID ${id}.`,
        );
      }
      if (dispositivo.revocado) {
        throw new BadRequestException('El dispositivo ya está revocado.');
      }

      const actualizado = await tx.dispositivoTaquilla.update({
        where: { id },
        data: { revocado: true, fechaActualizacion: getFechaUTC6() },
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'REVOCAR_DISPOSITIVO',
        modulo: MODULO_BITACORA,
        descripcion: `Se revocó la taquilla '${dispositivo.nombre ?? dispositivo.idDispositivo}' (serie ${dispositivo.serie}). Sus pases dejan de validar.`,
      });

      return actualizado;
    });
  }
}
