import { Module } from '@nestjs/common';
import { ModuloAccionesService } from './modulo-acciones.service';
import { ModuloAccionesController } from './modulo-acciones.controller';

@Module({
  controllers: [ModuloAccionesController],
  providers: [ModuloAccionesService],
  exports: [ModuloAccionesService],
})
export class ModuloAccionesModule {}
