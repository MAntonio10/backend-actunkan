import { PartialType } from '@nestjs/mapped-types';
import { CreatePuestoDto } from './create-puesto.dto';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdatePuestoDto extends PartialType(CreatePuestoDto) {
  @IsOptional()
  @IsBoolean({ message: 'El campo anulado debe ser un valor booleano (true/false).' })
  anulado?: boolean;
}
