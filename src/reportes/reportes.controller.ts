import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { EjecutorInfo, obtenerEjecutor } from '../common/utils/ejecutor.util';
import { GenerarReporteDto } from './dto/generar-reporte.dto';
import { InterpretarReporteDto } from './dto/interpretar-reporte.dto';
import { nombreArchivoSeguro } from './formato.util';
import { InterpretacionService } from './ia/interpretacion.service';
import { ReporteExcelService } from './reporte-excel.service';
import { ReportePdfService } from './reporte-pdf.service';
import { ReportesService } from './reportes.service';
import { DashboardService } from './dashboard/dashboard.service';
import type { GranoTemporal } from './dashboard/dashboard.contratos';
import { ResolutorFiltrosService } from './resolutor-filtros.service';

const TIPO_EXCEL =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Reportes del sistema, en dos vías.
 *
 * **Vía predeterminada** (`GET /reportes/:clave` y sus dos formatos): ejecuta uno de los
 * 18 reportes del catálogo. No sale a internet ni consume cuota de ningún servicio
 * externo; es la que usan los botones del frontend.
 *
 * **Vía a medida** (`POST /reportes/interpretar`): traduce una petición escrita en
 * lenguaje natural a una de esas mismas 18 definiciones. Es la única ruta que llama a la
 * IA, y solo para elegir el reporte y los filtros: las cifras las produce después
 * exactamente el mismo código que la vía 1.
 *
 * Toda ruta declara su `@RequirePermission`: `PermissionsGuard` es fail-open por diseño y
 * un handler sin decorador queda abierto a cualquier usuario autenticado.
 */
@Controller('reportes')
export class ReportesController {
  constructor(
    private readonly reportesService: ReportesService,
    private readonly reportePdfService: ReportePdfService,
    private readonly reporteExcelService: ReporteExcelService,
    private readonly interpretacionService: InterpretacionService,
    private readonly resolutor: ResolutorFiltrosService,
    private readonly dashboardService: DashboardService,
  ) {}

  private exigirEjecutor(req: any): EjecutorInfo {
    const ejecutor = obtenerEjecutor(req);
    if (!ejecutor?.id) {
      throw new UnauthorizedException(
        'No se pudo determinar el usuario que solicita el reporte.',
      );
    }
    return ejecutor;
  }

  /** Catálogo de reportes que puede ejecutar quien pregunta. Alimenta el menú del frontend. */
  @Get()
  @RequirePermission('Reportes', 'Ver')
  catalogo(@Request() req: any) {
    return this.reportesService.listarCatalogo(this.exigirEjecutor(req));
  }

  /**
   * Traduce una petición en lenguaje natural y la ejecuta.
   *
   * Devuelve el resultado en JSON para pintar la tabla, el formato que la IA dedujo de la
   * frase y una `urlDescarga` de la vía 1 ya armada. La descarga se hace contra esa URL, o
   * sea que **descargar el archivo no cuesta otra llamada a la IA**, ni la primera vez ni
   * al cambiar de PDF a Excel.
   *
   * El límite propio es más estricto que el global: la cuota gratuita del proveedor es el
   * recurso escaso, no el ancho de banda.
   */
  @Post('interpretar')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Reportes', 'Ver')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  async interpretar(@Body() dto: InterpretarReporteDto, @Request() req: any) {
    const ejecutor = this.exigirEjecutor(req);
    const interpretado = await this.interpretacionService.interpretar(
      dto.instruccion,
    );

    // `generarDetallado` devuelve también los filtros resueltos, así que la URL de
    // descarga se arma sin repetir las búsquedas de nombres contra la base.
    const { resultado, filtros } = await this.reportesService.generarDetallado(
      interpretado.clave,
      interpretado.filtros,
      ejecutor,
      'json',
    );

    const query = this.resolutor.construirQueryString(
      interpretado.filtros,
      filtros,
    );

    return {
      instruccion: dto.instruccion,
      interpretacion: interpretado.interpretacion,
      // Lo que el frontend necesita para convertir esta petición en un botón permanente.
      especificacion: {
        clave: interpretado.clave,
        filtros: interpretado.filtros,
      },
      formato: interpretado.formato,
      urlDescarga: `/reportes/${interpretado.clave}/${interpretado.formato}?${query}`,
      resultado,
    };
  }

  /**
   * Panel de gráficas.
   *
   * Va declarado **antes** que `@Get(':clave')`: Nest resuelve por orden de
   * declaración y el parámetro se tragaría la palabra 'dashboard', respondiendo
   * que no existe un reporte con esa clave. Es el mismo motivo por el que
   * `/cajas/cierres` va antes que `/cajas/:id`.
   *
   * Exige `Reportes.Ver` como todo lo demás, y cada panel comprueba además el
   * permiso del módulo dueño de sus datos: quien no tenga Donaciones no ve el
   * panel de donaciones, y se le dice por qué en `omitidos`.
   */
  @Get('dashboard')
  @RequirePermission('Reportes', 'Ver')
  async dashboard(@Query() query: GenerarReporteDto, @Request() req: any) {
    const ejecutor = this.exigirEjecutor(req);

    // El panel solo entiende de fechas: aceptar filtros sueltos daría la falsa
    // impresión de que todas sus gráficas los respetan.
    const permitidos = ['desde', 'hasta', 'grano'];
    const sobrantes = Object.entries(query)
      .filter(([nombre, valor]) => !permitidos.includes(nombre) && valor)
      .map(([nombre]) => nombre);
    if (sobrantes.length > 0) {
      throw new BadRequestException(
        `El panel solo acepta ${permitidos.join(', ')}. Quite: ${sobrantes.join(', ')}.`,
      );
    }

    const filtros = await this.resolutor.resolver(query);
    return this.dashboardService.generar(
      filtros,
      ejecutor,
      query.grano as GranoTemporal | undefined,
    );
  }

  /** Un reporte del catálogo, en JSON. Sin IA. */
  @Get(':clave')
  @RequirePermission('Reportes', 'Ver')
  generar(
    @Param('clave') clave: string,
    @Query() query: GenerarReporteDto,
    @Request() req: any,
  ) {
    return this.reportesService.generar(
      clave,
      query,
      this.exigirEjecutor(req),
      'json',
    );
  }

  /** El mismo reporte en PDF, listo para imprimir. Sin IA. */
  @Get(':clave/pdf')
  @RequirePermission('Reportes', 'Exportar')
  async pdf(
    @Param('clave') clave: string,
    @Query() query: GenerarReporteDto,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const reporte = await this.reportesService.generar(
      clave,
      query,
      this.exigirEjecutor(req),
      'pdf',
    );
    const pdf = await this.reportePdfService.generar(reporte);

    res.set({
      'Content-Type': 'application/pdf',
      // `inline` como el resto de PDF del proyecto: el navegador sí sabe mostrarlos.
      'Content-Disposition': `inline; filename="${this.nombreArchivo(clave, reporte.periodo)}.pdf"`,
      'Content-Length': pdf.length.toString(),
    });
    res.end(pdf);
  }

  /** El mismo reporte en Excel, con los números como números. Sin IA. */
  @Get(':clave/excel')
  @RequirePermission('Reportes', 'Exportar')
  async excel(
    @Param('clave') clave: string,
    @Query() query: GenerarReporteDto,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const reporte = await this.reportesService.generar(
      clave,
      query,
      this.exigirEjecutor(req),
      'excel',
    );
    const libro = await this.reporteExcelService.generar(reporte);

    res.set({
      'Content-Type': TIPO_EXCEL,
      // `attachment` y no `inline`: ningún navegador renderiza un xlsx, y en línea solo
      // consigue abrirse como basura binaria en una pestaña.
      'Content-Disposition': `attachment; filename="${this.nombreArchivo(clave, reporte.periodo)}.xlsx"`,
      'Content-Length': libro.length.toString(),
    });
    res.end(libro);
  }

  private nombreArchivo(
    clave: string,
    periodo?: { desde: string; hasta: string },
  ): string {
    const sufijo = periodo ? `-${periodo.desde}-a-${periodo.hasta}` : '';
    const nombre = nombreArchivoSeguro(`${clave}${sufijo}`);
    if (!nombre) {
      throw new BadRequestException(
        'No se pudo construir el nombre del archivo del reporte.',
      );
    }
    return nombre;
  }
}
