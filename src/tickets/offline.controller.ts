import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { OfflineService } from './offline.service';
import { ConciliarLoteDto, CrearLoteOfflineDto, QueryLoteActivoDto } from './dto/lote-offline.dto';
import { EmitirOfflineDto } from './dto/emitir-offline.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermiteUsuarioAnulado } from '../common/decorators/permite-usuario-anulado.decorator';
import { obtenerEjecutor } from '../common/utils/ejecutor.util';

/**
 * Venta de tickets sin conexión: reserva de folios, subida de la cola y cierre
 * del lote. Todo se gobierna con el permiso `EmisionTickets`, igual que el resto
 * del módulo de emisión.
 *
 * Va en un controlador aparte de `TicketsController` porque son rutas de tres
 * segmentos (`/tickets/lotes-offline/...`) y no colisionan con `/tickets/:id`.
 */
@Controller('tickets')
export class OfflineController {
  constructor(private readonly offlineService: OfflineService) {}

  @Post('lotes-offline')
  @RequirePermission('EmisionTickets', 'Crear')
  reservar(@Body() dto: CrearLoteOfflineDto, @Request() req: any) {
    return this.offlineService.reservar(dto, obtenerEjecutor(req));
  }

  @Get('lotes-offline/activo')
  @RequirePermission('EmisionTickets', 'Ver')
  obtenerActivo(@Query() query: QueryLoteActivoDto, @Request() req: any) {
    return this.offlineService.obtenerActivo(query.idDispositivo, obtenerEjecutor(req));
  }

  /**
   * Éxito parcial: responde `200` con el resultado de cada venta. Nunca un `4xx`
   * para el lote completo si al menos un ítem es válido — el resto corresponde a
   * dinero que ya entró al cajón.
   *
   * Abierto a un usuario dado de baja: por eso mismo. Las ventas ya se cobraron;
   * no registrarlas no las deshace, solo deja la caja descuadrada.
   */
  @Post('emitir-offline')
  @HttpCode(HttpStatus.OK)
  @PermiteUsuarioAnulado()
  @RequirePermission('EmisionTickets', 'Crear')
  emitirOffline(@Body() dto: EmitirOfflineDto, @Request() req: any) {
    return this.offlineService.emitirOffline(dto, obtenerEjecutor(req));
  }

  /** Cerrar el lote es parte de liquidar, así que un usuario dado de baja también puede. */
  @Post('lotes-offline/:id/conciliar')
  @HttpCode(HttpStatus.OK)
  @PermiteUsuarioAnulado()
  @RequirePermission('EmisionTickets', 'Crear')
  conciliar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConciliarLoteDto,
    @Request() req: any,
  ) {
    return this.offlineService.conciliar(id, dto, obtenerEjecutor(req));
  }

  @Delete('lotes-offline/:id')
  @RequirePermission('EmisionTickets', 'Anular')
  invalidar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.offlineService.invalidar(id, obtenerEjecutor(req));
  }
}
