import { Controller, Get, Post, Body, Patch, Param, Delete, ParseIntPipe, Query, Request } from '@nestjs/common';
import { CajasService } from './cajas.service';
import { AbrirCajaDto } from './dto/abrir-caja.dto';
import { CerrarCajaDto } from './dto/cerrar-caja.dto';
import { QueryCajaDto } from './dto/query-caja.dto';
import { QueryCierreDto } from './dto/query-cierre.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('cajas')
export class CajasController {
  constructor(private readonly cajasService: CajasService) {}

  private getEjecutor(req: any) {
    if (!req.user) return undefined;
    return {
      id: req.user.sub ?? req.user.id,
      email: req.user.email,
    };
  }

  @Post('apertura')
  @RequirePermission('Cajas', 'Crear')
  abrirCaja(@Body() abrirCajaDto: AbrirCajaDto, @Request() req: any) {
    return this.cajasService.abrirCaja(abrirCajaDto, this.getEjecutor(req));
  }

  @Get()
  @RequirePermission('Cajas', 'Ver')
  findAll(@Query() query: QueryCajaDto, @Request() req: any) {
    return this.cajasService.findAll(query, this.getEjecutor(req)?.id);
  }

  /**
   * Historial de cierres para supervisión. Exige `Cajas.Editar` porque expone el
   * monto esperado y la diferencia de cada arqueo.
   *
   * Debe declararse antes de `@Get(':id')` para que la ruta literal gane.
   */
  @Get('cierres')
  @RequirePermission('Cajas', 'Editar')
  historialCierres(@Query() query: QueryCierreDto) {
    return this.cajasService.historialCierres(query);
  }

  /**
   * "No hay caja abierta" es un estado normal, no un error.
   *
   * Se responde siempre con un objeto: devolver `null` hacía que NestJS enviara un
   * cuerpo vacío (sin `content-type`), y `response.json()` en el cliente fallaba con
   * "Unexpected end of JSON input". El campo `hayCajaAbierta` evita además tener que
   * deducir el estado a partir de un nulo.
   */
  @Get('actual')
  @RequirePermission('Cajas', 'Ver')
  async obtenerActual() {
    const caja = await this.cajasService.obtenerActual();
    return { hayCajaAbierta: caja !== null, caja: caja ?? null };
  }

  @Get(':id')
  @RequirePermission('Cajas', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.cajasService.findOne(id, this.getEjecutor(req)?.id ?? 0);
  }

  /**
   * Arqueo previo al cierre. Exige `Cajas.Editar` (supervisión), no `Ver`:
   * si el cajero conociera el monto esperado, bastaría teclear esa cifra para que
   * ningún faltante saliera nunca a la luz.
   */
  @Get(':id/arqueo')
  @RequirePermission('Cajas', 'Editar')
  arqueo(@Param('id', ParseIntPipe) id: number) {
    return this.cajasService.arqueo(id);
  }

  @Post(':id/cierre')
  @RequirePermission('Cajas', 'Crear')
  cerrarCaja(@Param('id', ParseIntPipe) id: number, @Body() cerrarCajaDto: CerrarCajaDto, @Request() req: any) {
    return this.cajasService.cerrarCaja(id, cerrarCajaDto, this.getEjecutor(req));
  }

  /**
   * Anular el cierre reabre la caja. Exige `Cajas.Editar` (supervisión), no `Anular`:
   * de lo contrario el cajero podría cerrar, ver la diferencia, anular y volver a
   * cerrar con la cifra exacta, dejando el arqueo sin valor de control.
   */
  @Patch(':id/cierre/anular')
  @RequirePermission('Cajas', 'Editar')
  anularCierre(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.cajasService.anularCierre(id, this.getEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('Cajas', 'Anular')
  anularApertura(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.cajasService.anularApertura(id, this.getEjecutor(req));
  }
}
