import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { CreateGastoDto } from './dto/create-gasto.dto';
import { UpdateGastoDto } from './dto/update-gasto.dto';
import { getFechaUTC6 } from '../common/utils/date.util';

export interface EjecutorInfo {
  id: number;
  email?: string;
}

const INCLUDE_DETALLE = {
  tipoGasto: true,
};

@Injectable()
export class GastosService {
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
   * Un gasto solo puede crearse, editarse o anularse mientras su caja sigue abierta.
   * Tocarlo después del cierre alteraría de forma retroactiva el arqueo ya guardado.
   */
  private async exigirCajaAbierta(tx: any, idAperturaCaja: number | null, accion: string) {
    if (!idAperturaCaja) {
      throw new BadRequestException(
        `El gasto no está asociado a ninguna caja, no es posible ${accion}.`,
      );
    }

    const caja = await tx.aperturaCaja.findUnique({
      where: { id: idAperturaCaja },
      include: { estado: true },
    });

    if (!caja || caja.anulado || caja.estado.nombre !== 'Abierta') {
      throw new BadRequestException(
        `La caja (ID ${idAperturaCaja}) no se encuentra abierta; no es posible ${accion} porque alteraría un arqueo ya cerrado.`,
      );
    }

    return caja;
  }

  async create(createGastoDto: CreateGastoDto, ejecutor?: EjecutorInfo) {
    const cajaActual = await this.cajasService.obtenerActual();
    if (!cajaActual) {
      throw new BadRequestException('No hay una caja abierta para registrar el gasto.');
    }

    return this.prisma.$transaction(async (tx) => {
      const tipoGasto = await tx.tipoGasto.findUnique({ where: { id: createGastoDto.idTipoGasto } });
      if (!tipoGasto || tipoGasto.anulado) {
        throw new BadRequestException(
          `El tipo de gasto con ID ${createGastoDto.idTipoGasto} no existe o se encuentra anulado.`,
        );
      }

      // Revalidar dentro de la transacción: la caja pudo cerrarse entre
      // obtenerActual() y este insert.
      await this.exigirCajaAbierta(tx, cajaActual.id, 'registrar el gasto');

      const ahora = getFechaUTC6();
      const gasto = await tx.gastos.create({
        data: {
          idTipoGasto: createGastoDto.idTipoGasto,
          idAperturaCaja: cajaActual.id,
          idUsuario: ejecutor?.id,
          descripcion: createGastoDto.descripcion,
          monto: createGastoDto.monto,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'CREAR_GASTO',
        modulo: 'Gastos',
        descripcion: `Se registró el gasto '${gasto.descripcion}' por ${gasto.monto} en la caja abierta (ID ${cajaActual.id}).`,
      });

      return gasto;
    });
  }

  async findAll(idAperturaCaja?: number, incluirAnulados = false) {
    const where: any = incluirAnulados ? {} : { anulado: false };
    if (idAperturaCaja) {
      where.idAperturaCaja = idAperturaCaja;
    }

    return this.prisma.gastos.findMany({
      where,
      include: INCLUDE_DETALLE,
      orderBy: { fechaCreacion: 'desc' },
    });
  }

  async findOne(id: number) {
    const gasto = await this.prisma.gastos.findUnique({
      where: { id },
      include: INCLUDE_DETALLE,
    });

    if (!gasto) {
      throw new NotFoundException(`No se encontró el gasto solicitado con el ID ${id}.`);
    }

    return gasto;
  }

  async update(id: number, updateGastoDto: UpdateGastoDto, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const gasto = await tx.gastos.findUnique({ where: { id } });
      if (!gasto) {
        throw new NotFoundException(`No se encontró el gasto solicitado con el ID ${id}.`);
      }

      await this.exigirCajaAbierta(tx, gasto.idAperturaCaja, 'editar el gasto');

      if (updateGastoDto.idTipoGasto) {
        const tipoGasto = await tx.tipoGasto.findUnique({ where: { id: updateGastoDto.idTipoGasto } });
        if (!tipoGasto || tipoGasto.anulado) {
          throw new BadRequestException(
            `El tipo de gasto con ID ${updateGastoDto.idTipoGasto} no existe o se encuentra anulado.`,
          );
        }
      }

      const gastoActualizado = await tx.gastos.update({
        where: { id },
        data: { ...updateGastoDto, fechaActualizacion: getFechaUTC6() },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'EDITAR_GASTO',
        modulo: 'Gastos',
        descripcion: `Se actualizó el gasto '${gastoActualizado.descripcion}' (ID: ${id}).`,
      });

      return gastoActualizado;
    });
  }

  async remove(id: number, ejecutor?: EjecutorInfo) {
    return this.prisma.$transaction(async (tx) => {
      const gasto = await tx.gastos.findUnique({ where: { id } });
      if (!gasto) {
        throw new NotFoundException(`No se encontró el gasto solicitado con el ID ${id}.`);
      }

      await this.exigirCajaAbierta(tx, gasto.idAperturaCaja, 'anular el gasto');

      const gastoAnulado = await tx.gastos.update({
        where: { id },
        data: { anulado: true, fechaActualizacion: getFechaUTC6() },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ANULAR_GASTO',
        modulo: 'Gastos',
        descripcion: `Se anuló el gasto '${gastoAnulado.descripcion}' (ID: ${id}).`,
      });

      return gastoAnulado;
    });
  }
}
