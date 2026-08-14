import { Module } from '@nestjs/common';
import { TiposGastoService } from './tipos-gasto.service';
import { TiposGastoController } from './tipos-gasto.controller';

@Module({
  controllers: [TiposGastoController],
  providers: [TiposGastoService],
  exports: [TiposGastoService],
})
export class TiposGastoModule {}
