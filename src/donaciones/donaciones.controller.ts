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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { DonacionesService } from './donaciones.service';
import { DonacionPdfService } from './donacion-pdf.service';
import { CrearDonacionDto } from './dto/crear-donacion.dto';
import { AnularDonacionDto, QueryDonacionDto } from './dto/query-donacion.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { obtenerEjecutor } from '../common/utils/ejecutor.util';

/**
 * Donaciones en efectivo. El recibo es **no contable** y solo se puede anular:
 * igual que los tickets, un documento emitido no se edita.
 */
@Controller('donaciones')
export class DonacionesController {
  constructor(
    private readonly donacionesService: DonacionesService,
    private readonly donacionPdfService: DonacionPdfService,
  ) {}

  @Post()
  @RequirePermission('Donaciones', 'Crear')
  crear(@Body() dto: CrearDonacionDto, @Request() req: any) {
    return this.donacionesService.crear(dto, obtenerEjecutor(req));
  }

  @Get()
  @RequirePermission('Donaciones', 'Ver')
  findAll(@Query() query: QueryDonacionDto) {
    return this.donacionesService.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Donaciones', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.donacionesService.findOne(id);
  }

  /** Recibo imprimible, mismo formato de 80 mm que el pase de acceso. */
  @Get(':id/pdf')
  @RequirePermission('Donaciones', 'Ver')
  async pdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const donacion = await this.donacionesService.findOne(id);
    const pdf = await this.donacionPdfService.generar(donacion);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${donacion.numeroRecibo}.pdf"`,
      'Content-Length': pdf.length.toString(),
    });
    res.end(pdf);
  }

  @Delete(':id')
  @RequirePermission('Donaciones', 'Anular')
  anular(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AnularDonacionDto,
    @Request() req: any,
  ) {
    return this.donacionesService.anular(id, dto?.motivo, obtenerEjecutor(req));
  }
}
