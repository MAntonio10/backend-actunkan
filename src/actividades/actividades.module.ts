import { Module } from '@nestjs/common';
import { ActividadesService } from './actividades.service';
import { AlmacenamientoImagenesService } from './almacenamiento-imagenes.service';
import { ActividadesController } from './actividades.controller';

@Module({
  controllers: [ActividadesController],
  providers: [ActividadesService, AlmacenamientoImagenesService],
  exports: [ActividadesService],
})
export class ActividadesModule {}
