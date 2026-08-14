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
import { GastosService } from './gastos.service';
import { CreateGastoDto } from './dto/create-gasto.dto';
import { UpdateGastoDto } from './dto/update-gasto.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('gastos')
export class GastosController {
  constructor(private readonly gastosService: GastosService) {}

  private getEjecutor(req: any) {
    if (!req.user) return undefined;
    return {
      id: req.user.sub ?? req.user.id,
      email: req.user.email,
    };
  }

  @Post()
  @RequirePermission('Gastos', 'Crear')
  create(@Body() createGastoDto: CreateGastoDto, @Request() req: any) {
    return this.gastosService.create(createGastoDto, this.getEjecutor(req));
  }

  @Get()
  @RequirePermission('Gastos', 'Ver')
  findAll(
    @Query('idAperturaCaja') idAperturaCaja?: string,
    @Query('incluirAnulados') incluirAnulados?: string,
  ) {
    return this.gastosService.findAll(
      idAperturaCaja ? Number(idAperturaCaja) : undefined,
      incluirAnulados === 'true',
    );
  }

  @Get(':id')
  @RequirePermission('Gastos', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.gastosService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('Gastos', 'Editar')
  update(@Param('id', ParseIntPipe) id: number, @Body() updateGastoDto: UpdateGastoDto, @Request() req: any) {
    return this.gastosService.update(id, updateGastoDto, this.getEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('Gastos', 'Anular')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.gastosService.remove(id, this.getEjecutor(req));
  }
}
