import { PartialType } from '@nestjs/mapped-types';
import { CreateGastoDto } from './create-gasto.dto';

/**
 * `anulado` no se expone a propósito: la baja se hace por DELETE /gastos/:id,
 * que valida el estado de la caja y registra en bitácora.
 */
export class UpdateGastoDto extends PartialType(CreateGastoDto) {}
