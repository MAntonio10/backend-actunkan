import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../common/utils/date.util';
import {
  construirRespuestaPaginada,
  resolverPaginacion,
} from '../common/utils/paginacion.util';
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
    const paginacion = resolverPaginacion(query);

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

    /**
     * Lo recaudado se calcula **siempre** sobre los recibos vigentes, aunque el
     * listado incluya los anulados.
     *
     * Un recibo anulado no recaudó nada: ese dinero salió del arqueo cuando se
     * anuló (ver 15.6). Si el total lo sumara, bastaría con marcar
     * `incluirAnulados=true` para ver una recaudación que no existe, y el número
     * dejaría de coincidir con lo que la caja realmente recibió.
     */
    const whereVigentes = { ...where, anulado: false };

    // Las cifras describen **el mismo conjunto que el listado**: si los anulados no
    // se están mostrando, tampoco se reportan. Así se cumple siempre
    // `totalRecibos = recibosVigentes + recibosAnulados`, y la pantalla se puede
    // cuadrar de un vistazo.
    const listadoIncluyeAnulados = where.anulado !== false;
    const SIN_ANULADOS = { _sum: { monto: null }, _count: { _all: 0 } };

    const [datos, total, vigentes, anulados] = await Promise.all([
      this.prisma.donacion.findMany({
        where,
        include: INCLUDE_DETALLE,
        // El folio es texto: su orden alfabético no es el cronológico.
        // El desempate por `id` no es decorativo: SQL Server resuelve `skip`/`take`
        // con OFFSET..FETCH, y sobre una clave de orden que se repite no garantiza
        // un orden estable entre páginas: una fila puede salir dos veces o ninguna.
        orderBy: [{ fechaCreacion: 'desc' }, { id: 'desc' }],
        skip: paginacion.skip,
        take: paginacion.take,
      }),
      this.prisma.donacion.count({ where }),
      this.prisma.donacion.aggregate({
        where: whereVigentes,
        _sum: { monto: true },
        _count: { _all: true },
      }),
      listadoIncluyeAnulados
        ? this.prisma.donacion.aggregate({
            where: { ...where, anulado: true },
            _sum: { monto: true },
            _count: { _all: true },
          })
        : Promise.resolve(SIN_ANULADOS),
    ]);

    return {
      ...construirRespuestaPaginada(datos, total, paginacion),
      metricas: {
        // Cuántos trae el listado con el filtro aplicado; cuadra con la paginación.
        totalRecibos: total,
        recibosVigentes: vigentes._count._all,
        montoRecaudado: (vigentes._sum.monto ?? new Prisma.Decimal(0)).toString(),
        // Se exponen para que la diferencia entre recibos y recaudación sea
        // explicable en pantalla, en vez de parecer un error de cuadre.
        recibosAnulados: anulados._count._all,
        montoAnulado: (anulados._sum.monto ?? new Prisma.Decimal(0)).toString(),
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
