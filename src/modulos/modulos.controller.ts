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
import { ModulosService } from './modulos.service';
import { CreateModuloDto } from './dto/create-modulo.dto';
import { UpdateModuloDto } from './dto/update-modulo.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('modulos')
export class ModulosController {
  constructor(private readonly modulosService: ModulosService) {}

  @Post()
  @RequirePermission('modulos', 'crear')
  create(@Body() createModuloDto: CreateModuloDto) {
    return this.modulosService.create(createModuloDto);
  }

  @Get()
  @RequirePermission('modulos', 'ver')
  findAll(@Query('incluirAnulados') incluirAnulados?: string) {
    return this.modulosService.findAll(incluirAnulados === 'true');
  }

  @Get(':id')
  @RequirePermission('modulos', 'ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.modulosService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('modulos', 'editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateModuloDto: UpdateModuloDto,
  ) {
    return this.modulosService.update(id, updateModuloDto);
  }

  @Delete(':id')
  @RequirePermission('modulos', 'anular')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.modulosService.remove(id);
  }
}
