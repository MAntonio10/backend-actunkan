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
} from '@nestjs/common';
import { SectoresService } from './sectores.service';
import { ActualizarSectorDto, CrearSectorDto } from './dto/crear-sector.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { obtenerEjecutor } from '../common/utils/ejecutor.util';

/**
 * Sectores del parque: el catálogo que alimenta `idSectorParque` de las actividades.
 * No es un módulo de permiso aparte; se gobierna con `ActividadesParque`.
 */
@Controller('sectores')
export class SectoresController {
  constructor(private readonly sectoresService: SectoresService) {}

  @Post()
  @RequirePermission('ActividadesParque', 'Crear')
  crear(@Body() dto: CrearSectorDto, @Request() req: any) {
    return this.sectoresService.crear(dto, obtenerEjecutor(req));
  }

  @Get()
  @RequirePermission('ActividadesParque', 'Ver')
  findAll(@Query('incluirAnulados') incluirAnulados?: string) {
    return this.sectoresService.findAll(incluirAnulados === 'true');
  }

  @Get(':id')
  @RequirePermission('ActividadesParque', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.sectoresService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('ActividadesParque', 'Editar')
  actualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarSectorDto,
    @Request() req: any,
  ) {
    return this.sectoresService.actualizar(id, dto, obtenerEjecutor(req));
  }

  @Patch(':id/activar')
  @RequirePermission('ActividadesParque', 'Editar')
  activar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.sectoresService.activar(id, obtenerEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('ActividadesParque', 'Anular')
  anular(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.sectoresService.anular(id, obtenerEjecutor(req));
  }
}
