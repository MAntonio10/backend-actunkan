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
import { PuestosService } from './puestos.service';
import { CreatePuestoDto } from './dto/create-puesto.dto';
import { UpdatePuestoDto } from './dto/update-puesto.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('puestos')
export class PuestosController {
  constructor(private readonly puestosService: PuestosService) {}

  private getEjecutor(req: any) {
    if (!req.user) return undefined;
    return {
      id: req.user.sub ?? req.user.id,
      email: req.user.email,
    };
  }

  @Post()
  @RequirePermission('Puestos', 'Crear')
  create(@Body() createPuestoDto: CreatePuestoDto, @Request() req: any) {
    return this.puestosService.create(createPuestoDto, this.getEjecutor(req));
  }

  @Get()
  @RequirePermission('Puestos', 'Ver')
  findAll(@Query('incluirAnulados') incluirAnulados?: string) {
    return this.puestosService.findAll(incluirAnulados === 'true');
  }

  @Get(':id')
  @RequirePermission('Puestos', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.puestosService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('Puestos', 'Editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updatePuestoDto: UpdatePuestoDto,
    @Request() req: any,
  ) {
    return this.puestosService.update(id, updatePuestoDto, this.getEjecutor(req));
  }

  @Patch(':id/activar')
  @RequirePermission('Puestos', 'Editar')
  activar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.puestosService.activar(id, this.getEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('Puestos', 'Anular')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.puestosService.remove(id, this.getEjecutor(req));
  }
}
