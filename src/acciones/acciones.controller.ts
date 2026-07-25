import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
} from '@nestjs/common';
import { AccionesService } from './acciones.service';
import { CreateAccionDto } from './dto/create-accion.dto';
import { UpdateAccionDto } from './dto/update-accion.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('acciones')
export class AccionesController {
  constructor(private readonly accionesService: AccionesService) {}

  @Post()
  @RequirePermission('acciones', 'crear')
  create(@Body() createAccionDto: CreateAccionDto) {
    return this.accionesService.create(createAccionDto);
  }

  @Get()
  @RequirePermission('acciones', 'ver')
  findAll() {
    return this.accionesService.findAll();
  }

  @Get(':id')
  @RequirePermission('acciones', 'ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.accionesService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('acciones', 'editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateAccionDto: UpdateAccionDto,
  ) {
    return this.accionesService.update(id, updateAccionDto);
  }

  @Delete(':id')
  @RequirePermission('acciones', 'anular')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.accionesService.remove(id);
  }
}
