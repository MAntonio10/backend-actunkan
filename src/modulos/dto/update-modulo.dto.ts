import { PartialType } from '@nestjs/mapped-types';
import { CreateModuloDto } from './create-modulo.dto';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateModuloDto extends PartialType(CreateModuloDto) {
  @IsOptional()
  @IsBoolean({ message: 'El campo anulado debe ser un valor booleano (true/false).' })
  anulado?: boolean;
}
