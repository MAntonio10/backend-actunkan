import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  Request,
} from '@nestjs/common';
import { AccionesService } from './acciones.service';
import { CreateAccionDto } from './dto/create-accion.dto';
import { UpdateAccionDto } from './dto/update-accion.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('acciones')
export class AccionesController {
  constructor(private readonly accionesService: AccionesService) {}

  private getEjecutor(req: any) {
    if (!req.user) return undefined;
    return {
      id: req.user.sub ?? req.user.id,
      email: req.user.email,
    };
  }

  @Post()
  @RequirePermission('Acciones', 'Crear')
  create(@Body() createAccionDto: CreateAccionDto, @Request() req: any) {
    return this.accionesService.create(createAccionDto, this.getEjecutor(req));
  }

  @Get()
  @RequirePermission('Acciones', 'Ver')
  findAll() {
    return this.accionesService.findAll();
  }

  @Get(':id')
  @RequirePermission('Acciones', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.accionesService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('Acciones', 'Editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateAccionDto: UpdateAccionDto,
    @Request() req: any,
  ) {
    return this.accionesService.update(id, updateAccionDto, this.getEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('Acciones', 'Anular')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.accionesService.remove(id, this.getEjecutor(req));
  }
}
