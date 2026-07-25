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
  @RequirePermission('Modulos', 'Crear')
  create(@Body() createModuloDto: CreateModuloDto, @Request() req: any) {
    return this.modulosService.create(createModuloDto, this.getEjecutor(req));
  }

  @Get()
  @RequirePermission('Modulos', 'Ver')
  findAll(@Query('incluirAnulados') incluirAnulados?: string) {
    return this.modulosService.findAll(incluirAnulados === 'true');
  }

  @Get(':id')
  @RequirePermission('Modulos', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.modulosService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('Modulos', 'Editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateModuloDto: UpdateModuloDto,
    @Request() req: any,
  ) {
    return this.modulosService.update(id, updateModuloDto, this.getEjecutor(req));
  }

  @Patch(':id/activar')
  @RequirePermission('Modulos', 'Editar')
  activar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.modulosService.activar(id, this.getEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('Modulos', 'Anular')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.modulosService.remove(id, this.getEjecutor(req));
  }
}
