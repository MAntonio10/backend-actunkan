import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PagosService } from './pagos.service';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('pagos')
export class PagosController {
  constructor(private readonly pagosService: PagosService) {}

  /**
   * Estado del cobro para la página pública de éxito, de solo lectura.
   *
   * Es `@Public()` porque quien paga no tiene sesión en el sistema. Reemplazó al
   * `POST .../confirmar`, que preguntaba a la pasarela y confirmaba el cobro: con
   * eso, un pago real se quedaba sin confirmar para siempre si el visitante no
   * volvía a esta página. Ahora quien confirma es el webhook y esto solo mira lo
   * que ya quedó escrito.
   *
   * Devuelve lo mínimo —estado, monto y folio— y nunca el QR ni la firma: con eso
   * cualquiera podría fabricarse un pase. Tampoco el nombre del grupo ni cuántas
   * personas son, que son datos de una persona en un endpoint sin credenciales.
   *
   * El límite es más alto que el del `POST` que reemplaza porque la página sondea:
   * con 20/min se cortaba a los veinte intentos.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('checkout/:idCheckout')
  estadoDeCheckout(@Param('idCheckout') idCheckout: string) {
    return this.pagosService.estadoDeCheckout(idCheckout);
  }

  /** Estado de los pagos de un ticket, para pantallas internas. */
  @Get('ticket/:idTicket')
  @RequirePermission('EmisionTickets', 'Ver')
  estadoPorTicket(@Param('idTicket', ParseIntPipe) idTicket: number) {
    return this.pagosService.estadoPorTicket(idTicket);
  }
}
