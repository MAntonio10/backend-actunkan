import { Module } from '@nestjs/common';
import { DispositivosController } from './dispositivos.controller';
import { DispositivosService } from './dispositivos.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CajasModule } from '../cajas/cajas.module';

@Module({
  imports: [PrismaModule, CajasModule],
  controllers: [DispositivosController],
  providers: [DispositivosService],
  exports: [DispositivosService],
})
export class DispositivosModule {}
