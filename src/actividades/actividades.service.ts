import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../common/utils/date.util';
import {
  PAGINACION_ACTIVIDADES,
  construirRespuestaPaginada,
  resolverPaginacion,
} from '../common/utils/paginacion.util';
import { AlmacenamientoImagenesService } from './almacenamiento-imagenes.service';
import { ActualizarActividadDto, CrearActividadDto } from './dto/crear-actividad.dto';
import { QueryActividadDto } from './dto/query-actividad.dto';

const INCLUDE_DETALLE = {
  autor: { select: { id: true, nombre: true, correo: true } },
  responsable: { select: { id: true, nombre: true, correo: true } },
  sector: { select: { id: true, nombre: true } },
  imagenes: {
    select: {
      id: true,
      archivo: true,
      nombreOriginal: true,
      mimeType: true,
      tamanoBytes: true,
      orden: true,
    },
    orderBy: { orden: 'asc' as const },
  },
};

@Injectable()
export class ActividadesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly almacenamiento: AlmacenamientoImagenesService,
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
   * Editar y anular son exclusivos del autor, por encima del permiso del módulo:
   * tener `Editar` habilita publicar y mantener lo propio, no tocar lo ajeno.
   */
  private async exigirAutoria(id: number, ejecutor?: EjecutorInfo) {
    const actividad = await this.prisma.actividadesParque.findUnique({ where: { id } });

    if (!actividad) {
      throw new NotFoundException(`No se encontró la actividad con el ID ${id}.`);
    }

    if (!ejecutor?.id || actividad.idUsuarioAutor !== ejecutor.id) {
      throw new ForbiddenException(
        'Solo el autor de la publicación puede modificarla o anularla.',
      );
    }

    return actividad;
  }

  private validarVentana(inicio: Date, fin?: Date | null) {
    if (fin && fin <= inicio) {
      throw new BadRequestException(
        'La fecha de fin debe ser posterior a la fecha de inicio.',
      );
    }
  }

  /**
   * Reloj para comparar la ventana de visibilidad.
   *
   * Usa la hora real, **no** `getFechaUTC6()`: `fechaInicio` y `fechaFin` llegan del
   * cliente como marcas de tiempo reales, y compararlas contra el reloj desplazado
   * 6 horas dejaba oculta cualquier actividad programada para "ahora" durante ese lapso.
   * `getFechaUTC6()` se sigue usando para sellar fechaCreacion, como el resto del proyecto.
   */
  private ahoraReal(): Date {
    return new Date();
  }

  /** Marca el estado de vigencia sin exponer lógica de fechas al frontend. */
  private conVigencia(actividad: any, ahora: Date) {
    const expirada = Boolean(actividad.fechaFin && actividad.fechaFin <= ahora);
    const programada = actividad.fechaInicio > ahora;

    return {
      ...actividad,
      vigente: !expirada && !programada && !actividad.anulado,
      expirada,
      programada,
    };
  }

  async crear(dto: CrearActividadDto, ejecutor?: EjecutorInfo) {
    if (!ejecutor?.id) {
      throw new BadRequestException('No se pudo determinar el autor de la publicación.');
    }

    const fechaInicio = new Date(dto.fechaInicio);
    const fechaFin = dto.fechaFin ? new Date(dto.fechaFin) : null;
    this.validarVentana(fechaInicio, fechaFin);

    return this.prisma.$transaction(async (tx) => {
      if (dto.idSectorParque) {
        const sector = await tx.sectorParque.findUnique({ where: { id: dto.idSectorParque } });
        if (!sector || sector.anulado) {
          throw new BadRequestException(
            `El sector con ID ${dto.idSectorParque} no existe o está anulado.`,
          );
        }
      }

      if (dto.idUsuarioResponsable) {
        const responsable = await tx.usuario.findUnique({
          where: { id: dto.idUsuarioResponsable },
        });
        if (!responsable || responsable.anulado) {
          throw new BadRequestException(
            `El usuario responsable con ID ${dto.idUsuarioResponsable} no existe o está anulado.`,
          );
        }
      }

      const ahora = getFechaUTC6();
      const actividad = await tx.actividadesParque.create({
        data: {
          idUsuarioAutor: ejecutor.id,
          idUsuarioResponsable: dto.idUsuarioResponsable ?? null,
          idSectorParque: dto.idSectorParque ?? null,
          nombreActividad: dto.nombreActividad.trim(),
          descripcionActividad: dto.descripcionActividad,
          fechaInicio,
          fechaFin,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'PUBLICAR_ACTIVIDAD',
        modulo: 'ActividadesParque',
        descripcion: `Se publicó la actividad '${actividad.nombreActividad}' (ID ${actividad.id}).`,
      });

      return this.conVigencia(actividad, this.ahoraReal());
    });
  }

  /**
   * Listado visible para el usuario autenticado.
   *
   * Las publicaciones ajenas solo aparecen dentro de su ventana de fechas; las
   * propias se ven siempre, marcadas como expiradas o programadas, para que el
   * autor pueda reprogramarlas.
   */
  async findAll(query: QueryActividadDto, idUsuario?: number) {
    const { buscar, idSectorParque, idUsuarioAutor, incluirAnuladas, soloAnuladas, soloMias } =
      query || {};
    const paginacion = resolverPaginacion(query, PAGINACION_ACTIVIDADES);
    const ahora = this.ahoraReal();

    const where: any = {};
    const condiciones: any[] = [];
    const esPropia = { idUsuarioAutor: idUsuario ?? -1 };

    if (idSectorParque) where.idSectorParque = idSectorParque;
    if (idUsuarioAutor) where.idUsuarioAutor = idUsuarioAutor;
    if (soloMias === 'true') where.idUsuarioAutor = idUsuario ?? -1;

    if (buscar) {
      where.OR = [
        { nombreActividad: { contains: buscar } },
        { descripcionActividad: { contains: buscar } },
      ];
    }

    // Las anuladas ajenas no se muestran nunca, con flag o sin él: `findOne`
    // responde 404 a un tercero por una publicación anulada, y el listado no
    // puede contradecirlo. `soloAnuladas` gana sobre `incluirAnuladas`, igual
    // que en el historial de cierres de caja.
    if (soloAnuladas === 'true') {
      where.anulado = true;
      condiciones.push(esPropia);
    } else if (incluirAnuladas === 'true') {
      condiciones.push({ OR: [{ anulado: false }, esPropia] });
    } else {
      where.anulado = false;
    }

    // Vigencia: propias siempre; ajenas solo dentro de la ventana. Se aplica
    // siempre, para que ningún parámetro de consulta pueda saltársela.
    const dentroDeVentana = {
      fechaInicio: { lte: ahora },
      OR: [{ fechaFin: null }, { fechaFin: { gt: ahora } }],
    };

    condiciones.push({ OR: [esPropia, dentroDeVentana] });

    if (condiciones.length) where.AND = condiciones;

    const [datos, total] = await Promise.all([
      this.prisma.actividadesParque.findMany({
        where,
        include: INCLUDE_DETALLE,
        // El desempate por `id` no es decorativo: SQL Server resuelve `skip`/`take`
        // con OFFSET..FETCH, y si la clave de orden se repite —varias publicaciones
        // pueden empezar el mismo día— el motor no garantiza un orden estable entre
        // páginas, así que una fila puede salir dos veces o no salir nunca.
        orderBy: [{ fechaInicio: 'desc' }, { id: 'desc' }],
        skip: paginacion.skip,
        take: paginacion.take,
      }),
      this.prisma.actividadesParque.count({ where }),
    ]);

    return construirRespuestaPaginada(
      datos.map((a) => ({
        ...this.conVigencia(a, ahora),
        esAutor: a.idUsuarioAutor === idUsuario,
      })),
      total,
      paginacion,
    );
  }

  async findOne(id: number, idUsuario?: number) {
    const actividad = await this.prisma.actividadesParque.findUnique({
      where: { id },
      include: INCLUDE_DETALLE,
    });

    if (!actividad) {
      throw new NotFoundException(`No se encontró la actividad con el ID ${id}.`);
    }

    const ahora = this.ahoraReal();
    const esAutor = actividad.idUsuarioAutor === idUsuario;
    const conEstado = this.conVigencia(actividad, ahora);

    // Una publicación fuera de su ventana no se muestra a terceros, aunque
    // tengan permiso: la ventana es justamente lo que el autor controla.
    if (!esAutor && (conEstado.expirada || conEstado.programada || actividad.anulado)) {
      throw new NotFoundException(`No se encontró la actividad con el ID ${id}.`);
    }

    return { ...conEstado, esAutor };
  }

  async actualizar(id: number, dto: ActualizarActividadDto, ejecutor?: EjecutorInfo) {
    const actual = await this.exigirAutoria(id, ejecutor);

    if (actual.anulado) {
      throw new BadRequestException('No se puede editar una publicación anulada.');
    }

    const fechaInicio = dto.fechaInicio ? new Date(dto.fechaInicio) : actual.fechaInicio;
    const fechaFin = dto.fechaFin !== undefined
      ? dto.fechaFin
        ? new Date(dto.fechaFin)
        : null
      : actual.fechaFin;
    this.validarVentana(fechaInicio, fechaFin);

    return this.prisma.$transaction(async (tx) => {
      const actualizada = await tx.actividadesParque.update({
        where: { id },
        data: {
          ...(dto.nombreActividad ? { nombreActividad: dto.nombreActividad.trim() } : {}),
          ...(dto.descripcionActividad ? { descripcionActividad: dto.descripcionActividad } : {}),
          ...(dto.idSectorParque !== undefined ? { idSectorParque: dto.idSectorParque } : {}),
          ...(dto.idUsuarioResponsable !== undefined
            ? { idUsuarioResponsable: dto.idUsuarioResponsable }
            : {}),
          fechaInicio,
          fechaFin,
          fechaActualizacion: getFechaUTC6(),
        },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'EDITAR_ACTIVIDAD',
        modulo: 'ActividadesParque',
        descripcion: `Se actualizó la actividad '${actualizada.nombreActividad}' (ID ${id}).`,
      });

      return this.conVigencia(actualizada, this.ahoraReal());
    });
  }

  async anular(id: number, ejecutor?: EjecutorInfo) {
    const actual = await this.exigirAutoria(id, ejecutor);

    if (actual.anulado) {
      throw new BadRequestException('La publicación ya se encuentra anulada.');
    }

    return this.prisma.$transaction(async (tx) => {
      const anulada = await tx.actividadesParque.update({
        where: { id },
        data: { anulado: true, fechaActualizacion: getFechaUTC6() },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ANULAR_ACTIVIDAD',
        modulo: 'ActividadesParque',
        descripcion: `Se anuló la actividad '${anulada.nombreActividad}' (ID ${id}).`,
      });

      return this.conVigencia(anulada, this.ahoraReal());
    });
  }

  /**
   * Devuelve a la vista una publicación anulada.
   *
   * Exclusivo del autor, igual que anular: el permiso del módulo habilita
   * publicar y mantener lo propio, no reponer lo que otro retiró. La ventana de
   * visibilidad no se toca, así que una publicación ya expirada vuelve como
   * expirada; para que se vea otra vez hay que moverle la fecha de fin.
   */
  async activar(id: number, ejecutor?: EjecutorInfo) {
    const actual = await this.exigirAutoria(id, ejecutor);

    if (!actual.anulado) {
      throw new BadRequestException('La publicación ya se encuentra activa.');
    }

    return this.prisma.$transaction(async (tx) => {
      const activada = await tx.actividadesParque.update({
        where: { id },
        data: { anulado: false, fechaActualizacion: getFechaUTC6() },
        include: INCLUDE_DETALLE,
      });

      await BitacoraService.registrarEnTransaccion(tx, {
        idUsuario: ejecutor?.id,
        usuarioNombre: await this.obtenerNombreEjecutor(tx, ejecutor),
        accion: 'ACTIVAR_ACTIVIDAD',
        modulo: 'ActividadesParque',
        descripcion: `Se reactivó la actividad '${activada.nombreActividad}' (ID ${id}).`,
      });

      return this.conVigencia(activada, this.ahoraReal());
    });
  }

  // --- Imágenes ---

  async agregarImagen(
    idActividad: number,
    archivo: { originalname: string; buffer: Buffer; mimetype: string; size: number },
    ejecutor?: EjecutorInfo,
  ) {
    await this.exigirAutoria(idActividad, ejecutor);

    if (!archivo) {
      throw new BadRequestException('No se recibió ninguna imagen.');
    }

    // Se valida antes de escribir para no dejar basura en disco si el archivo no sirve.
    this.almacenamiento.validar(archivo);
    const nombreArchivo = this.almacenamiento.guardar(archivo);

    const ultima = await this.prisma.imagenActividad.findFirst({
      where: { idActividad },
      orderBy: { orden: 'desc' },
    });

    return this.prisma.imagenActividad.create({
      data: {
        idActividad,
        archivo: nombreArchivo,
        nombreOriginal: archivo.originalname.slice(0, 255),
        mimeType: archivo.mimetype,
        tamanoBytes: archivo.size,
        orden: (ultima?.orden ?? -1) + 1,
        fechaCreacion: getFechaUTC6(),
      },
      select: { id: true, archivo: true, nombreOriginal: true, mimeType: true, orden: true },
    });
  }

  /** Datos necesarios para servir el archivo, con la misma regla de visibilidad. */
  async obtenerImagenParaDescarga(idActividad: number, idImagen: number, idUsuario?: number) {
    await this.findOne(idActividad, idUsuario);

    const imagen = await this.prisma.imagenActividad.findFirst({
      where: { id: idImagen, idActividad },
    });

    if (!imagen || !this.almacenamiento.existe(imagen.archivo)) {
      throw new NotFoundException('No se encontró la imagen solicitada.');
    }

    return { imagen, ruta: this.almacenamiento.rutaDe(imagen.archivo) };
  }

  async eliminarImagen(idActividad: number, idImagen: number, ejecutor?: EjecutorInfo) {
    await this.exigirAutoria(idActividad, ejecutor);

    const imagen = await this.prisma.imagenActividad.findFirst({
      where: { id: idImagen, idActividad },
    });

    if (!imagen) {
      throw new NotFoundException('No se encontró la imagen solicitada.');
    }

    await this.prisma.imagenActividad.delete({ where: { id: idImagen } });
    this.almacenamiento.eliminar(imagen.archivo);

    return { mensaje: 'Imagen eliminada.', id: idImagen };
  }
}
