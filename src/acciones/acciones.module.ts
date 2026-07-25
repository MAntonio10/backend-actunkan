import { Module } from '@nestjs/common';
import { AccionesService } from './acciones.service';
import { AccionesController } from './acciones.controller';

@Module({
  controllers: [AccionesController],
  providers: [AccionesService],
  exports: [AccionesService],
})
export class AccionesModule {}
