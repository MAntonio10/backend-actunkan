import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../common/utils/date.util';
import { generarCorrelativo } from '../common/utils/correlativo.util';
import { CrearDonacionDto } from './dto/crear-donacion.dto';
import { QueryDonacionDto } from './dto/query-donacion.dto';

/** Serie del folio del recibo. Independiente de la de tickets. */
export const SERIE_DONACION = 'DON';

const INCLUDE_DETALLE = {
  usuario: { select: { id: true, nombre: true, correo: true } },
  aperturaCaja: { select: { id: true, fechaCreacion: true } },
};

@Injectable()
export class DonacionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cajasService: CajasService,
  ) {}

  private async obtenerNombreEjecutor(tx: any, ejecutor?: EjecutorInfo) {
    let nombreEjecutor = ejecutor?.email;
    if (ejecutor?.id) {
      const uEj = await tx.usuario.findUnique({ where: { id: ejecutor.id } });
      if (uEj) nombreEjecutor = uEj.nombre;
    }
    return nombreEjecutor;
  }

  /**
   * La donación es efectivo que entra al mismo cajón que las ventas, así que
   * exige caja abierta: sin ella el dinero no tendría a qué arqueo pertenecer.
   */
  private async exigirCajaAbierta(tx: any, idAperturaCaja: number, accion: string) {
    const caja = await tx.aperturaCaja.findUnique({
      where: { id: idAperturaCaja },
      include: { estado: true },
    });

    if (!caja || caja.anulado || caja.estado.nombre !== 'Abierta') {
      throw new BadRequestException(
        `La caja no se encuentra abierta; no es posible ${accion} porque alteraría un arqueo ya cerrado.`,
      );
    }

    return caja;
  }

  async crear(dto: CrearDonacionDto, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException('No se pudo determinar el usuario que recibe la donación.');
    }

    const cajaActual = await this.cajasService.obtenerActual();
    if (!cajaActual) {
      throw new BadRequestException(
        'No hay una caja abierta para registrar la donación. Abra la caja antes de recibirla.',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        // La caja pudo cerrarse entre la consulta anterior y esta transacción.
        await this.exigirCajaAbierta(tx, cajaActual.id, 'registrar la donación');

        const ahora = getFechaUTC6();
        const numeroRecibo = await generarCorrelativo(tx, SERIE_DONACION, ahora.getFullYear());

        const donacion = await tx.donacion.create({
          data: {
            numeroRecibo,
            idAperturaCaja: cajaActual.id,
            idUsuario: ejecutor.id,
            nombreDonante: dto.nombreDonante?.trim() || null,
            monto: new Prisma.Decimal(dto.monto),
            observaciones: dto.observaciones,
            fechaCreacion: ahora,
            fechaActualizacion: ahora,
          },
          include: INCLUDE_DETALLE,
        });

        await BitacoraService.registrarEnTransaccion(tx, {
          idUsuario: ejecutor.id,
          usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
          accion: 'REGISTRAR_DONACION',
          modulo: 'Donaciones',
          descripcion:
            `Se registró la donación ${numeroRecibo} por ${dto.monto} ` +
            `de '${donacion.nombreDonante ?? 'Donante anónimo'}'.`,
        });

        return donacion;
        // Serializable: el correlativo del recibo no puede repetirse si dos
        // ventanillas registran donaciones a la vez.
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async findAll(query: QueryDonacionDto) {
    const { buscar, idUsuario, idAperturaCaja, fechaInicio, fechaFin, incluirAnulados } =
      query || {};
    const pagina = query?.pagina && query.pagina > 0 ? query.pagina : 1;
    const limite = query?.limite && query.limite > 0 ? query.limite : 50;

    const where: any = {};

    if (incluirAnulados !== 'true') where.anulado = false;
    if (idUsuario) where.idUsuario = idUsuario;
    if (idAperturaCaja) where.idAperturaCaja = idAperturaCaja;

    if (fechaInicio || fechaFin) {
      where.fechaCreacion = {};
      if (fechaInicio) where.fechaCreacion.gte = new Date(fechaInicio);
      if (fechaFin) where.fechaCreacion.lte = new Date(fechaFin);
    }

    if (buscar) {
      where.OR = [
        { numeroRecibo: { contains: buscar } },
        { nombreDonante: { contains: buscar } },
      ];
    }

    const [datos, total, agregados] = await Promise.all([
      this.prisma.donacion.findMany({
        where,
        include: INCLUDE_DETALLE,
        // El folio es texto: su orden alfabético no es el cronológico.
        orderBy: { fechaCreacion: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
      }),
      this.prisma.donacion.count({ where }),
      this.prisma.donacion.aggregate({ where, _sum: { monto: true } }),
    ]);

    return {
      datos,
      total,
      pagina,
      limite,
      metricas: {
        totalRecibos: total,
        montoRecaudado: (agregados._sum.monto ?? new Prisma.Decimal(0)).toString(),
      },
    };
  }

  async findOne(id: number) {
    const donacion = await this.prisma.donacion.findUnique({
      where: { id },
      include: INCLUDE_DETALLE,
    });

    if (!donacion) {
      throw new NotFoundException(`No se encontró la donación con el ID ${id}.`);
    }

    return donacion;
  }

  /**
   * Baja lógica del recibo. Solo con la caja de origen abierta: anularlo después
   * del cierre cambiaría de forma retroactiva un arqueo ya guardado.
   */
  async anular(id: number, motivo: string | undefined, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const donacion = await tx.donacion.findUnique({ where: { id } });

      if (!donacion) {
        throw new NotFoundException(`No se encontró la donación con el ID ${id}.`);
      }

      if (donacion.anulado) {
        throw new BadRequestException(
          `El recibo ${donacion.numeroRecibo} ya se encuentra anulado.`,
        );
      }

      await this.exigirCajaAbierta(tx, donacion.idAperturaCaja, 'anular la donación');

      const anulada = await tx.donacion.update({
        where: { id },
        data: {
          anulado: true,
          motivoAnulacion: motivo?.trim() || null,
          fechaActualizacion: getFechaUTC6(),
        },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ANULAR_DONACION',
        modulo: 'Donaciones',
        descripcion:
          `Se anuló el recibo de donación ${anulada.numeroRecibo} por ${anulada.monto.toString()}.` +
          (motivo ? ` Motivo: ${motivo}.` : ''),
      });

      return anulada;
    });
  }
}
