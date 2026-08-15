import { Module } from '@nestjs/common';
import { PagosService } from './pagos.service';
import { RecurrenteService } from './recurrente.service';
import { PagosController } from './pagos.controller';

@Module({
  controllers: [PagosController],
  providers: [PagosService, RecurrenteService],
  exports: [PagosService, RecurrenteService],
})
export class PagosModule {}
