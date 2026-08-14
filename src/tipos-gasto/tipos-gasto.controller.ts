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
import { TiposGastoService } from './tipos-gasto.service';
import { CreateTipoGastoDto } from './dto/create-tipo-gasto.dto';
import { UpdateTipoGastoDto } from './dto/update-tipo-gasto.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('tipos-gasto')
export class TiposGastoController {
  constructor(private readonly tiposGastoService: TiposGastoService) {}

  private getEjecutor(req: any) {
    if (!req.user) return undefined;
    return {
      id: req.user.sub ?? req.user.id,
      email: req.user.email,
    };
  }

  @Post()
  @RequirePermission('Gastos','Crear')
  create(@Body() createTipoGastoDto: CreateTipoGastoDto, @Request() req: any) {
    return this.tiposGastoService.create(createTipoGastoDto, this.getEjecutor(req));
  }

  @Get()
  @RequirePermission('Gastos','Ver')
  findAll(@Query('incluirAnulados') incluirAnulados?: string) {
    return this.tiposGastoService.findAll(incluirAnulados === 'true');
  }

  @Get(':id')
  @RequirePermission('Gastos','Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.tiposGastoService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('Gastos','Editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateTipoGastoDto: UpdateTipoGastoDto,
    @Request() req: any,
  ) {
    return this.tiposGastoService.update(id, updateTipoGastoDto, this.getEjecutor(req));
  }

  @Patch(':id/activar')
  @RequirePermission('Gastos','Editar')
  activar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.tiposGastoService.activar(id, this.getEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('Gastos','Anular')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.tiposGastoService.remove(id, this.getEjecutor(req));
  }
}
