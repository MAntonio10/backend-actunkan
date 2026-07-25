import { PartialType } from '@nestjs/mapped-types';
import { CreateUsuarioDto } from './create-usuario.dto';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateUsuarioDto extends PartialType(CreateUsuarioDto) {
  @IsOptional()
  @IsString({ message: 'La nueva contraseña debe ser una cadena de texto.' })
  @MinLength(6, { message: 'La nueva contraseña debe tener al menos 6 caracteres.' })
  contrasena?: string;

  @IsOptional()
  @IsBoolean({ message: 'El campo anulado debe ser un valor booleano (true/false).' })
  anulado?: boolean;
}
