import { Module } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { CajasModule } from '../cajas/cajas.module';
import { BitacoraModule } from '../bitacora/bitacora.module';

@Module({
  imports: [CajasModule, BitacoraModule],
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
