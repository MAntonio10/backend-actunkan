import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  Query,
  Request,
} from '@nestjs/common';
import { ModulosService } from './modulos.service';
import { CreateModuloDto } from './dto/create-modulo.dto';
import { UpdateModuloDto } from './dto/update-modulo.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('modulos')
export class ModulosController {
  constructor(private readonly modulosService: ModulosService) {}

  private getEjecutor(req: any) {
    if (!req.user) return undefined;
    return {
      id: req.user.sub ?? req.user.id,
      email: req.user.email,
    };
  }

  @Post()
  @RequirePermission('Usuarios', 'Crear')
  create(@Body() createModuloDto: CreateModuloDto, @Request() req: any) {
    return this.modulosService.create(createModuloDto, this.getEjecutor(req));
  }

  @Get()
  @RequirePermission('Usuarios', 'Ver')
  findAll(
    @Query('incluirAnulados') incluirAnulados?: string,
    @Query('soloAsignables') soloAsignables?: string,
  ) {
    return this.modulosService.findAll(incluirAnulados === 'true', soloAsignables === 'true');
  }

  /**
   * Menú del usuario autenticado. Sin `@RequirePermission` a propósito: cada quien
   * puede consultar su propio acceso, y así el menú no depende de un permiso que
   * pueda perderse al reasignar.
   *
   * Debe declararse antes de `@Get(':id')` para que la ruta literal gane.
   */
  @Get('mis-modulos')
  misModulos(@Request() req: any) {
    return this.modulosService.findModulosDelUsuario(req.user.sub ?? req.user.id);
  }

  @Get(':id')
  @RequirePermission('Usuarios', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.modulosService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('Usuarios', 'Editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateModuloDto: UpdateModuloDto,
    @Request() req: any,
  ) {
    return this.modulosService.update(id, updateModuloDto, this.getEjecutor(req));
  }

  @Patch(':id/activar')
  @RequirePermission('Usuarios', 'Editar')
  activar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.modulosService.activar(id, this.getEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('Usuarios', 'Anular')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.modulosService.remove(id, this.getEjecutor(req));
  }
}
