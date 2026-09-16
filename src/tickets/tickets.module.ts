import { Module } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketPdfService } from './ticket-pdf.service';
import { TicketsController } from './tickets.controller';
import { OfflineService } from './offline.service';
import { OfflineController } from './offline.controller';
import { GuiasModule } from '../guias/guias.module';
import { PagosModule } from '../pagos/pagos.module';
import { CajasModule } from '../cajas/cajas.module';
import { BitacoraModule } from '../bitacora/bitacora.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [CajasModule, BitacoraModule, GuiasModule, PagosModule, MailModule],
  // OfflineController va primero para que `/tickets/lotes-offline/...` se resuelva
  // antes de que Nest evalúe las rutas con parámetro de TicketsController.
  controllers: [OfflineController, TicketsController],
  providers: [TicketsService, TicketPdfService, OfflineService],
  exports: [TicketsService, TicketPdfService, OfflineService],
})
export class TicketsModule {}
