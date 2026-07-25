import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  ParseIntPipe,
} from '@nestjs/common';
import { ModuloAccionesService } from './modulo-acciones.service';
import { CreateModuloAccionDto } from './dto/create-modulo-accion.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('modulo-acciones')
export class ModuloAccionesController {
  constructor(
    private readonly moduloAccionesService: ModuloAccionesService,
  ) {}

  @Post()
  @RequirePermission('modulos', 'editar')
  create(@Body() createModuloAccionDto: CreateModuloAccionDto) {
    return this.moduloAccionesService.create(createModuloAccionDto);
  }

  @Get()
  @RequirePermission('modulos', 'ver')
  findAll() {
    return this.moduloAccionesService.findAll();
  }

  @Get('modulo/:idModulo')
  @RequirePermission('modulos', 'ver')
  findByModulo(@Param('idModulo', ParseIntPipe) idModulo: number) {
    return this.moduloAccionesService.findByModulo(idModulo);
  }

  @Get(':id')
  @RequirePermission('modulos', 'ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.moduloAccionesService.findOne(id);
  }

  @Delete(':id')
  @RequirePermission('modulos', 'anular')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.moduloAccionesService.remove(id);
  }
}
