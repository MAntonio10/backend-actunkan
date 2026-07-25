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
} from '@nestjs/common';
import { PuestosService } from './puestos.service';
import { CreatePuestoDto } from './dto/create-puesto.dto';
import { UpdatePuestoDto } from './dto/update-puesto.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('puestos')
export class PuestosController {
  constructor(private readonly puestosService: PuestosService) {}

  @Post()
  @RequirePermission('puestos', 'crear')
  create(@Body() createPuestoDto: CreatePuestoDto) {
    return this.puestosService.create(createPuestoDto);
  }

  @Get()
  @RequirePermission('puestos', 'ver')
  findAll(@Query('incluirAnulados') incluirAnulados?: string) {
    return this.puestosService.findAll(incluirAnulados === 'true');
  }

  @Get(':id')
  @RequirePermission('puestos', 'ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.puestosService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('puestos', 'editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updatePuestoDto: UpdatePuestoDto,
  ) {
    return this.puestosService.update(id, updatePuestoDto);
  }

  @Delete(':id')
  @RequirePermission('puestos', 'anular')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.puestosService.remove(id);
  }
}
