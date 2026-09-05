import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { ActividadesService } from './actividades.service';
import { TAMANO_MAXIMO_BYTES } from './almacenamiento-imagenes.service';
import { ActualizarActividadDto, CrearActividadDto } from './dto/crear-actividad.dto';
import { QueryActividadDto } from './dto/query-actividad.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { obtenerEjecutor } from '../common/utils/ejecutor.util';

/**
 * Planificación de actividades del parque.
 *
 * El permiso del módulo habilita ver y publicar; **editar y anular quedan
 * reservados al autor** de cada publicación, se verifica en el servicio.
 */
@Controller('actividades')
export class ActividadesController {
  constructor(private readonly actividadesService: ActividadesService) {}

  @Post()
  @RequirePermission('ActividadesParque', 'Crear')
  crear(@Body() dto: CrearActividadDto, @Request() req: any) {
    return this.actividadesService.crear(dto, obtenerEjecutor(req));
  }

  @Get()
  @RequirePermission('ActividadesParque', 'Ver')
  findAll(@Query() query: QueryActividadDto, @Request() req: any) {
    return this.actividadesService.findAll(query, obtenerEjecutor(req)?.id);
  }

  @Get(':id')
  @RequirePermission('ActividadesParque', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.actividadesService.findOne(id, obtenerEjecutor(req)?.id);
  }

  @Patch(':id')
  @RequirePermission('ActividadesParque', 'Editar')
  actualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarActividadDto,
    @Request() req: any,
  ) {
    return this.actividadesService.actualizar(id, dto, obtenerEjecutor(req));
  }

  /**
   * Reactiva una publicación anulada. Pide `Editar` y no `Anular`, igual que en
   * usuarios, puestos y sectores: reponer es mantenimiento del propio
   * contenido, no la baja. La autoría se sigue exigiendo en el servicio.
   */
  @Patch(':id/activar')
  @RequirePermission('ActividadesParque', 'Editar')
  activar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.actividadesService.activar(id, obtenerEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('ActividadesParque', 'Anular')
  anular(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.actividadesService.anular(id, obtenerEjecutor(req));
  }

  // --- Imágenes ---

  /**
   * Sube una imagen (campo `imagen`, multipart/form-data).
   * El archivo va a disco; en la base solo queda su ruta.
   */
  @Post(':id/imagenes')
  @RequirePermission('ActividadesParque', 'Editar')
  @UseInterceptors(FileInterceptor('imagen', { limits: { fileSize: TAMANO_MAXIMO_BYTES } }))
  agregarImagen(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() imagen: any,
    @Request() req: any,
  ) {
    return this.actividadesService.agregarImagen(id, imagen, obtenerEjecutor(req));
  }

  /**
   * Sirve la imagen. Va por endpoint y no como archivo estático para que respete
   * el permiso del módulo y la ventana de visibilidad de la publicación.
   */
  @Get(':id/imagenes/:idImagen')
  @RequirePermission('ActividadesParque', 'Ver')
  async descargarImagen(
    @Param('id', ParseIntPipe) id: number,
    @Param('idImagen', ParseIntPipe) idImagen: number,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const { imagen, ruta } = await this.actividadesService.obtenerImagenParaDescarga(
      id,
      idImagen,
      obtenerEjecutor(req)?.id,
    );

    res.set({
      'Content-Type': imagen.mimeType,
      'Content-Length': imagen.tamanoBytes.toString(),
      'Content-Disposition': `inline; filename="${imagen.nombreOriginal.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=86400',
    });

    createReadStream(ruta).pipe(res);
  }

  @Delete(':id/imagenes/:idImagen')
  @RequirePermission('ActividadesParque', 'Editar')
  eliminarImagen(
    @Param('id', ParseIntPipe) id: number,
    @Param('idImagen', ParseIntPipe) idImagen: number,
    @Request() req: any,
  ) {
    return this.actividadesService.eliminarImagen(id, idImagen, obtenerEjecutor(req));
  }
}
