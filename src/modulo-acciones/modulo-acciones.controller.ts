import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  ParseIntPipe,
  Query,
  Request,
} from '@nestjs/common';
import { ModuloAccionesService } from './modulo-acciones.service';
import { CreateModuloAccionDto } from './dto/create-modulo-accion.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('modulo-acciones')
export class ModuloAccionesController {
  constructor(
    private readonly moduloAccionesService: ModuloAccionesService,
  ) {}

  private getEjecutor(req: any) {
    if (!req.user) return undefined;
    return {
      id: req.user.sub ?? req.user.id,
      email: req.user.email,
    };
  }

  @Post()
  @RequirePermission('Usuarios', 'Editar')
  create(@Body() createModuloAccionDto: CreateModuloAccionDto, @Request() req: any) {
    return this.moduloAccionesService.create(createModuloAccionDto, this.getEjecutor(req));
  }

  /**
   * Devuelve solo los vínculos asignables (módulos activos y no de infraestructura),
   * que es lo que debe alimentar la pantalla de asignación de permisos.
   * `?incluirNoAsignables=true` muestra todo, para administración o diagnóstico.
   */
  @Get()
  @RequirePermission('Usuarios', 'Ver')
  findAll(@Query('incluirNoAsignables') incluirNoAsignables?: string) {
    return this.moduloAccionesService.findAll(incluirNoAsignables === 'true');
  }

  @Get('modulo/:idModulo')
  @RequirePermission('Usuarios', 'Ver')
  findByModulo(@Param('idModulo', ParseIntPipe) idModulo: number) {
    return this.moduloAccionesService.findByModulo(idModulo);
  }

  @Get(':id')
  @RequirePermission('Usuarios', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.moduloAccionesService.findOne(id);
  }

  @Delete(':id')
  @RequirePermission('Usuarios', 'Anular')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.moduloAccionesService.remove(id, this.getEjecutor(req));
  }
}
