import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { DispositivosService } from './dispositivos.service';
import { RegistrarDispositivoDto } from './dto/registrar-dispositivo.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { obtenerEjecutor } from '../common/utils/ejecutor.util';

/**
 * Taquillas habilitadas para emitir sin conexión.
 *
 * Registrar un equipo es el momento con red que el modo sin conexión necesita haber
 * tenido alguna vez: aquí deja su llave pública y recibe su serie de folios. Con eso
 * ya puede emitir pases firmados por su cuenta el resto del turno, sin reservar
 * folios por adelantado.
 */
@Controller('dispositivos')
export class DispositivosController {
  constructor(private readonly dispositivosService: DispositivosService) {}

  @Post()
  @RequirePermission('Sincronizacion', 'Ver')
  registrar(@Body() dto: RegistrarDispositivoDto, @Request() req: any) {
    return this.dispositivosService.registrar(dto, obtenerEjecutor(req));
  }

  @Get()
  @RequirePermission('Sincronizacion', 'Ver')
  findAll(@Query('incluirRevocados') incluirRevocados?: string) {
    return this.dispositivosService.findAll(incluirRevocados === 'true');
  }

  /**
   * Revocar exige `Anular`, no `Ver`: deja sin valor los pases que ese equipo emitió
   * y todavía no subió, así que es la misma clase de decisión que descartar un cobro
   * sin conexión.
   */
  @Delete(':id')
  @RequirePermission('Sincronizacion', 'Anular')
  revocar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.dispositivosService.revocar(id, obtenerEjecutor(req));
  }
}
