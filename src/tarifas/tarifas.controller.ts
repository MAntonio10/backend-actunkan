import { Body, Controller, Get, Patch, Query, Request } from '@nestjs/common';
import { TarifasService } from './tarifas.service';
import { ActualizarTarifaDto, ActualizarTarifaGuiaDto } from './dto/actualizar-tarifa.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { obtenerEjecutor } from '../common/utils/ejecutor.util';

@Controller('tarifas')
export class TarifasController {
  constructor(private readonly tarifasService: TarifasService) {}

  @Get()
  @RequirePermission('EmisionTickets','Ver')
  findVigentes() {
    return this.tarifasService.findVigentes();
  }

  @Get('historico')
  @RequirePermission('EmisionTickets','Ver')
  findHistorico(
    @Query('idAtraccion') idAtraccion?: string,
    @Query('idOrigen') idOrigen?: string,
  ) {
    return this.tarifasService.findHistorico(
      idAtraccion ? Number(idAtraccion) : undefined,
      idOrigen ? Number(idOrigen) : undefined,
    );
  }

  @Get('guia')
  @RequirePermission('EmisionTickets','Ver')
  findTarifaGuia() {
    return this.tarifasService.findTarifaGuiaVigente();
  }

  @Patch()
  @RequirePermission('EmisionTickets','Editar')
  actualizarTarifa(@Body() dto: ActualizarTarifaDto, @Request() req: any) {
    return this.tarifasService.actualizarTarifa(dto, obtenerEjecutor(req));
  }

  @Patch('guia')
  @RequirePermission('EmisionTickets','Editar')
  actualizarTarifaGuia(@Body() dto: ActualizarTarifaGuiaDto, @Request() req: any) {
    return this.tarifasService.actualizarTarifaGuia(dto, obtenerEjecutor(req));
  }
}
