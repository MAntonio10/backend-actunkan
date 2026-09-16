import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { EjecutorInfo } from '../common/utils/ejecutor.util';
import { getFechaUTC6 } from '../common/utils/date.util';
import {
  DefinicionReporte,
  EspecificacionReporte,
  FilaReporte,
  FiltrosResueltos,
  FormatoSalida,
  ResultadoReporte,
} from './contratos';
import {
  CLAVES_REPORTE,
  REGISTRO_REPORTES,
  obtenerDefinicion,
} from './definiciones';
import { textoSeguroParaMensaje } from './formato.util';
import { GenerarReporteDto } from './dto/generar-reporte.dto';
import {
  parametrosDeclarados,
  parametrosNoDeclarados,
} from './parametros.util';
import { ResolutorFiltrosService } from './resolutor-filtros.service';

/**
 * Tope de filas por formato.
 *
 * El PDF retiene todas las páginas en memoria para poder numerarlas ("Página X de Y"), y
 * `Buffer.concat` duplica el pico al final: cinco mil filas son unas cien páginas, que ya
 * es más de lo que nadie va a leer. Excel aguanta un millón de filas por hoja y el límite
 * real es la memoria que consume `exceljs` al construir el libro.
 */
const LIMITE_FILAS: Record<FormatoSalida, number> = {
  json: 5_000,
  pdf: 5_000,
  excel: 50_000,
};

const MODULO_BITACORA = 'Reportes';

@Injectable()
export class ReportesService {
  private readonly logger = new Logger(ReportesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolutor: ResolutorFiltrosService,
    private readonly cajas: CajasService,
    private readonly bitacora: BitacoraService,
  ) {}

  /**
   * ¿Tiene el usuario esta acción sobre este módulo?
   *
   * Repite la consulta de `PermissionsGuard` porque aquí el permiso no se conoce hasta
   * saber qué reporte se pidió, y el guard trabaja con metadatos de la ruta, que son
   * estáticos.
   */
  private async tienePermiso(
    idUsuario: number,
    modulo: string,
    accion: string,
  ): Promise<boolean> {
    const permiso = await this.prisma.permisos.findFirst({
      where: {
        idUsuario,
        moduloAccion: {
          modulo: { nombre: modulo, anulado: false },
          accion: { nombre: accion },
        },
      },
      select: { id: true },
    });
    return Boolean(permiso);
  }

  /**
   * Catálogo de reportes que este usuario puede ejecutar.
   *
   * Se filtra por el permiso del módulo dueño de los datos: mostrarle a un cajero un
   * botón de "matriz de permisos" que siempre va a responder 403 solo genera llamadas a
   * soporte.
   */
  async listarCatalogo(ejecutor: EjecutorInfo) {
    const esSupervisor = await this.cajas.esSupervisor(ejecutor.id);

    const permitidos = await Promise.all(
      [...REGISTRO_REPORTES.values()].map(async (definicion) => {
        if (definicion.soloSupervisor && !esSupervisor) return null;
        const puede = await this.tienePermiso(
          ejecutor.id,
          definicion.moduloOrigen,
          'Ver',
        );
        if (!puede) return null;

        return {
          clave: definicion.clave,
          titulo: definicion.titulo,
          descripcion: definicion.descripcion,
          categoria: definicion.categoria,
          moduloOrigen: definicion.moduloOrigen,
          soloSupervisor: Boolean(definicion.soloSupervisor),
          orientacion: definicion.orientacionSugerida ?? 'vertical',
          // `clave` identifica el control que pinta el frontend; `parametros` son los
          // nombres reales de la query string. Casi siempre coinciden, pero el rango de
          // fechas es un solo control y dos parámetros: sin esta traducción, un
          // formulario genérico mandaría `periodo=...` y se llevaría un 400.
          filtros: definicion.filtros.map((filtro) => ({
            ...filtro,
            parametros:
              filtro.tipo === 'rangoFechas' ? ['desde', 'hasta'] : [filtro.clave],
          })),
          formatos: ['json', 'pdf', 'excel'],
        };
      }),
    );

    const datos = permitidos.filter((reporte) => reporte !== null);

    return {
      datos,
      total: datos.length,
      // El frontend lo usa para decidir si pinta el campo de petición en lenguaje natural.
      interpretacionDisponible: Boolean(process.env.IA_API_KEY),
    };
  }

  /**
   * Comprueba los permisos del reporte y devuelve el contexto con el que se ejecuta.
   *
   * `Reportes.Ver` abre el módulo, pero no los datos: cada definición declara de qué
   * módulo son las cifras que va a leer, y ese permiso se exige aparte. Sin esto, dar
   * acceso a reportes entregaría de golpe la bitácora, la matriz de permisos y las
   * donaciones a cualquiera que solo debía ver tickets.
   */
  private async autorizar(
    definicion: DefinicionReporte,
    ejecutor: EjecutorInfo,
  ) {
    const esSupervisor = await this.cajas.esSupervisor(ejecutor.id);

    if (definicion.soloSupervisor && !esSupervisor) {
      throw new ForbiddenException(
        `El reporte '${definicion.titulo}' solo lo puede consultar un supervisor ` +
          '(permiso Cajas + Editar).',
      );
    }

    if (
      !(await this.tienePermiso(ejecutor.id, definicion.moduloOrigen, 'Ver'))
    ) {
      throw new ForbiddenException(
        `Acceso denegado: el reporte '${definicion.titulo}' lee datos del módulo ` +
          `'${definicion.moduloOrigen}', y no cuenta con el permiso 'Ver' sobre ese módulo.`,
      );
    }

    return esSupervisor;
  }

  /**
   * Borra las columnas y KPIs de supervisión de la estructura de datos.
   *
   * Se borra el dato, no el dibujo. Ocultar la columna solo al renderizar dejaría el
   * `montoEsperado` viajando en el JSON del endpoint hermano y dentro del .xlsx, y el
   * control se defiende precisamente para que quien cuenta el efectivo no lo conozca:
   * si lo supiera, bastaría teclear esa cifra para que ningún faltante saliera a la luz.
   */
  private depurarSensibles(spec: EspecificacionReporte): EspecificacionReporte {
    return {
      ...spec,
      kpis: spec.kpis.filter((kpi) => !kpi.soloSupervisor),
      secciones: spec.secciones.map((seccion) => {
        const ocultas = seccion.columnas
          .filter((c) => c.soloSupervisor)
          .map((c) => c.clave);
        if (ocultas.length === 0) return seccion;

        const limpiar = (fila: FilaReporte): FilaReporte => {
          const copia = { ...fila };
          for (const clave of ocultas) delete copia[clave];
          return copia;
        };

        return {
          ...seccion,
          columnas: seccion.columnas.filter((c) => !c.soloSupervisor),
          filas: seccion.filas.map(limpiar),
          totales: seccion.totales ? limpiar(seccion.totales) : seccion.totales,
        };
      }),
    };
  }

  private nombreEjecutor(
    ejecutor: EjecutorInfo,
    nombre?: string | null,
  ): string {
    return nombre ?? ejecutor.email ?? `Usuario ${ejecutor.id}`;
  }

  /**
   * Ejecuta un reporte. **No sale a internet en ningún caso**: la IA no participa aquí,
   * ni siquiera cuando la petición vino de `POST /reportes/interpretar`, que se limita a
   * elegir la clave y los filtros antes de llamar a este método.
   */
  async generar(
    clave: string,
    dto: GenerarReporteDto,
    ejecutor: EjecutorInfo,
    formato: FormatoSalida = 'json',
  ): Promise<ResultadoReporte> {
    return (await this.generarDetallado(clave, dto, ejecutor, formato))
      .resultado;
  }

  /**
   * Igual que `generar`, pero devolviendo además los filtros ya resueltos.
   *
   * Lo usa la vía en lenguaje natural para armar la URL de descarga sin volver a resolver
   * los nombres contra la base: son las mismas consultas que ya se hicieron aquí.
   */
  async generarDetallado(
    clave: string,
    dto: GenerarReporteDto,
    ejecutor: EjecutorInfo,
    formato: FormatoSalida = 'json',
  ): Promise<{ resultado: ResultadoReporte; filtros: FiltrosResueltos }> {
    const definicion = obtenerDefinicion(clave);

    if (!definicion) {
      throw new NotFoundException(
        // La clave viene de la URL: se sanea antes de devolverla en el mensaje.
        `No existe el reporte '${textoSeguroParaMensaje(clave, 40)}'. ` +
          `Reportes disponibles: ${CLAVES_REPORTE.join(', ')}.`,
      );
    }

    const esSupervisor = await this.autorizar(definicion, ejecutor);

    // Un filtro que el reporte no declara no se aplica, pero sí se imprimiría en
    // la cabecera como si se hubiera aplicado. Se rechaza antes de resolver.
    const sobrantes = parametrosNoDeclarados(definicion, dto);
    if (sobrantes.length > 0) {
      throw new BadRequestException(
        `El reporte '${definicion.clave}' no acepta ${
          sobrantes.length === 1 ? 'el filtro' : 'los filtros'
        } ${sobrantes.join(', ')}. Acepta: ${[
          ...parametrosDeclarados(definicion),
        ].join(', ')}.`,
      );
    }

    const filtros = await this.resolutor.resolver(dto);
    const limiteFilas = LIMITE_FILAS[formato];

    const inicio = Date.now();
    const especificacion = await definicion.ejecutar({
      prisma: this.prisma,
      filtros,
      ejecutor,
      esSupervisor,
      limiteFilas,
    });
    const duracion = Date.now() - inicio;

    const depurada = esSupervisor
      ? especificacion
      : this.depurarSensibles(especificacion);

    const filasMostradas = depurada.secciones.reduce(
      (total, s) => total + s.filas.length,
      0,
    );
    const truncado = depurada.secciones.some(
      (s) => (s.filasDisponibles ?? s.filas.length) > s.filas.length,
    );

    if (truncado) {
      const disponibles = depurada.secciones.reduce(
        (total, s) => total + (s.filasDisponibles ?? s.filas.length),
        0,
      );
      depurada.notas = [
        `Se muestran ${filasMostradas.toLocaleString('es-GT')} de ` +
          `${disponibles.toLocaleString('es-GT')} filas disponibles. Acote el rango de fechas ` +
          `o descargue el reporte en Excel, que admite muchas más. ` +
          // Al recortar, la fila de totales deja de cuadrar con los indicadores:
          // decirlo evita que se lea como una cifra mal calculada.
          `Los indicadores de arriba resumen el período completo; la fila de totales suma ` +
          `solo las filas mostradas.`,
        ...(depurada.notas ?? []),
      ];
    }

    const usuario = await this.prisma.usuario.findUnique({
      where: { id: ejecutor.id },
      select: { nombre: true },
    });
    const generadoPor = this.nombreEjecutor(ejecutor, usuario?.nombre);

    await this.registrarEnBitacora(
      definicion,
      filtros.etiquetaPeriodo,
      formato,
      ejecutor,
      generadoPor,
    );

    this.logger.log(
      `Reporte '${textoSeguroParaMensaje(clave, 40)}' generado en ${duracion} ms ` +
        `(${filasMostradas} filas, formato ${formato}).`,
    );

    return {
      resultado: {
        ...depurada,
        clave: definicion.clave,
        orientacion:
          depurada.orientacion ?? definicion.orientacionSugerida ?? 'vertical',
        generadoEn: getFechaUTC6().toISOString(),
        generadoPor,
        truncado,
      },
      filtros,
    };
  }

  /**
   * Un reporte no cambia datos, pero sí los expone: dinero, nombres y permisos. Quién
   * consultó qué y cuándo tiene que quedar registrado igual que cualquier movimiento.
   */
  private async registrarEnBitacora(
    definicion: DefinicionReporte,
    periodo: string,
    formato: FormatoSalida,
    ejecutor: EjecutorInfo,
    nombre: string,
  ) {
    try {
      await this.bitacora.registrar({
        idUsuario: ejecutor.id,
        usuarioNombre: nombre,
        accion: formato === 'json' ? 'GENERAR_REPORTE' : 'EXPORTAR_REPORTE',
        modulo: MODULO_BITACORA,
        descripcion:
          `Se generó el reporte '${definicion.titulo}' (${definicion.clave}) ` +
          `en formato ${formato.toUpperCase()} para el período ${periodo}.`,
      });
    } catch (error: any) {
      // Que falle la auditoría no debe dejar al usuario sin su reporte, pero tampoco
      // puede pasar en silencio.
      this.logger.error(
        `No se pudo registrar en bitácora el reporte '${definicion.clave}': ${error.message}`,
      );
    }
  }
}
