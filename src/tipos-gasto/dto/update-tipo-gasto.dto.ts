import { PartialType } from '@nestjs/mapped-types';
import { CreateTipoGastoDto } from './create-tipo-gasto.dto';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateTipoGastoDto extends PartialType(CreateTipoGastoDto) {
  @IsOptional()
  @IsBoolean({ message: 'El campo anulado debe ser un valor booleano (true/false).' })
  anulado?: boolean;
}
