import { Module } from '@nestjs/common';
import { BitacoraModule } from '../bitacora/bitacora.module';
import { CajasModule } from '../cajas/cajas.module';
import { IaClienteService } from './ia/ia-cliente.service';
import { InterpretacionService } from './ia/interpretacion.service';
import { ReporteExcelService } from './reporte-excel.service';
import { ReportePdfService } from './reporte-pdf.service';
import { ReportesController } from './reportes.controller';
import { ReportesService } from './reportes.service';
import { DashboardService } from './dashboard/dashboard.service';
import { ResolutorFiltrosService } from './resolutor-filtros.service';

/**
 * `CajasModule` entra por `esSupervisor`, que es donde el proyecto tiene definido qué
 * significa supervisar una caja. Duplicar esa consulta aquí crearía una segunda definición
 * de "supervisor" que podría desincronizarse de la de `/cajas`, y con ella el control que
 * impide que el cajero conozca el monto esperado.
 *
 * `PrismaModule` es global, así que no hace falta importarlo.
 */
@Module({
  imports: [CajasModule, BitacoraModule],
  controllers: [ReportesController],
  providers: [
    ReportesService,
    ResolutorFiltrosService,
    ReportePdfService,
    ReporteExcelService,
    IaClienteService,
    InterpretacionService,
    DashboardService,
  ],
  exports: [ReportesService],
})
export class ReportesModule {}
