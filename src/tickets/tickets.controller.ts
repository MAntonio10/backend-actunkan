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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { TicketsService } from './tickets.service';
import { TicketPdfService } from './ticket-pdf.service';
import { EmitirTicketDto } from './dto/emitir-ticket.dto';
import { QueryTicketDto } from './dto/query-ticket.dto';
import { ValidarTicketDto } from './dto/validar-ticket.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { obtenerEjecutor } from '../common/utils/ejecutor.util';

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly ticketPdfService: TicketPdfService,
  ) {}

  /**
   * Datos de configuración que arman el formulario de emisión (atracciones, orígenes,
   * países, tipos, formas de pago, guías y tarifas vigentes) en una sola llamada.
   * Debe declararse antes de `@Get(':id')` para que la ruta literal gane.
   */
  @Get('catalogos')
  @RequirePermission('EmisionTickets', 'Ver')
  catalogos() {
    return this.ticketsService.obtenerCatalogos();
  }

  @Post('emitir')
  @RequirePermission('EmisionTickets','Crear')
  emitir(@Body() dto: EmitirTicketDto, @Request() req: any) {
    return this.ticketsService.emitir(dto, obtenerEjecutor(req));
  }

  @Get()
  @RequirePermission('EmisionTickets','Ver')
  findAll(@Query() query: QueryTicketDto) {
    return this.ticketsService.findAll(query);
  }

  /** Valida y sella un ticket existente: no crea nada, por eso responde 200 y no 201. */
  @Post('validar')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('EmisionTickets','Editar')
  validar(@Body() dto: ValidarTicketDto, @Request() req: any) {
    return this.ticketsService.validar(dto, obtenerEjecutor(req));
  }

  @Get(':id')
  @RequirePermission('EmisionTickets','Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.ticketsService.findOne(id);
  }

  /**
   * Pase de acceso en PDF, listo para descargar e imprimir. La página va dimensionada
   * al propio ticket (ancho de 80 mm), así sirve en impresora térmica y en una normal.
   */
  @Get(':id/pdf')
  @RequirePermission('EmisionTickets', 'Ver')
  async pdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const ticket = await this.ticketsService.findOne(id);
    const pdf = await this.ticketPdfService.generar(ticket);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${ticket.numeroTicket}.pdf"`,
      'Content-Length': pdf.length.toString(),
    });
    res.end(pdf);
  }

  @Delete(':id')
  @RequirePermission('EmisionTickets','Anular')
  anular(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.ticketsService.anular(id, obtenerEjecutor(req));
  }
}
