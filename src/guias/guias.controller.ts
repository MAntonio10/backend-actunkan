import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Request,
} from '@nestjs/common';
import { GuiasService } from './guias.service';
import { UpdateGuiaDto } from './dto/update-guia.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { obtenerEjecutor } from '../common/utils/ejecutor.util';

/**
 * Catálogo de guías. No expone alta: un guía nuevo se registra dentro de
 * `POST /tickets/emitir` (bloque `guia.modo: "nuevo"`), que es donde el taquillero
 * lo captura de verdad. Aquí solo se consulta, corrige y da de baja.
 */
@Controller('guias')
export class GuiasController {
  constructor(private readonly guiasService: GuiasService) {}

  @Get()
  @RequirePermission('EmisionTickets', 'Ver')
  findAll(
    @Query('buscar') buscar?: string,
    @Query('incluirAnulados') incluirAnulados?: string,
  ) {
    return this.guiasService.findAll(buscar, incluirAnulados === 'true');
  }

  @Get(':id')
  @RequirePermission('EmisionTickets', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.guiasService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('EmisionTickets', 'Editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGuiaDto,
    @Request() req: any,
  ) {
    return this.guiasService.update(id, dto, obtenerEjecutor(req));
  }

  @Patch(':id/activar')
  @RequirePermission('EmisionTickets', 'Editar')
  activar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.guiasService.activar(id, obtenerEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('EmisionTickets', 'Anular')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.guiasService.remove(id, obtenerEjecutor(req));
  }
}
