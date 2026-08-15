import { Module } from '@nestjs/common';
import { GuiasService } from './guias.service';
import { GuiasController } from './guias.controller';

@Module({
  controllers: [GuiasController],
  providers: [GuiasService],
  exports: [GuiasService],
})
export class GuiasModule {}
