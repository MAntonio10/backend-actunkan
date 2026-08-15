import { Module } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketPdfService } from './ticket-pdf.service';
import { TicketsController } from './tickets.controller';
import { GuiasModule } from '../guias/guias.module';
import { PagosModule } from '../pagos/pagos.module';
import { CajasModule } from '../cajas/cajas.module';
import { BitacoraModule } from '../bitacora/bitacora.module';

@Module({
  imports: [CajasModule, BitacoraModule, GuiasModule, PagosModule],
  controllers: [TicketsController],
  providers: [TicketsService, TicketPdfService],
  exports: [TicketsService, TicketPdfService],
})
export class TicketsModule {}
