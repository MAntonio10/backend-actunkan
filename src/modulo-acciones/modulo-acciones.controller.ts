import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  ParseIntPipe,
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
  @RequirePermission('Modulos', 'Editar')
  create(@Body() createModuloAccionDto: CreateModuloAccionDto, @Request() req: any) {
    return this.moduloAccionesService.create(createModuloAccionDto, this.getEjecutor(req));
  }

  @Get()
  @RequirePermission('Modulos', 'Ver')
  findAll() {
    return this.moduloAccionesService.findAll();
  }

  @Get('modulo/:idModulo')
  @RequirePermission('Modulos', 'Ver')
  findByModulo(@Param('idModulo', ParseIntPipe) idModulo: number) {
    return this.moduloAccionesService.findByModulo(idModulo);
  }

  @Get(':id')
  @RequirePermission('Modulos', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.moduloAccionesService.findOne(id);
  }

  @Delete(':id')
  @RequirePermission('Modulos', 'Anular')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.moduloAccionesService.remove(id, this.getEjecutor(req));
  }
}
