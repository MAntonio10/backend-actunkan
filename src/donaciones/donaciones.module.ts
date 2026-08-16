import { Module } from '@nestjs/common';
import { DonacionesService } from './donaciones.service';
import { DonacionPdfService } from './donacion-pdf.service';
import { DonacionesController } from './donaciones.controller';
import { CajasModule } from '../cajas/cajas.module';

@Module({
  imports: [CajasModule],
  controllers: [DonacionesController],
  providers: [DonacionesService, DonacionPdfService],
  exports: [DonacionesService, DonacionPdfService],
})
export class DonacionesModule {}
