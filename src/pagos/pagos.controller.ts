import { Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PagosService } from './pagos.service';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('pagos')
export class PagosController {
  constructor(private readonly pagosService: PagosService) {}

  /**
   * Lo llama la página pública de éxito cuando la pasarela redirige de vuelta.
   *
   * Es `@Public()` a propósito: quien paga no tiene sesión en el sistema, y esa
   * página es lo único que llega a ver. Aun así el estado no se toma del cliente:
   * el backend consulta a Recurrente con la llave secreta.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('checkout/:idCheckout/confirmar')
  confirmar(@Param('idCheckout') idCheckout: string) {
    return this.pagosService.confirmarCheckout(idCheckout);
  }

  /** Estado de los pagos de un ticket, para pantallas internas. */
  @Get('ticket/:idTicket')
  @RequirePermission('EmisionTickets', 'Ver')
  estadoPorTicket(@Param('idTicket', ParseIntPipe) idTicket: number) {
    return this.pagosService.estadoPorTicket(idTicket);
  }
}
