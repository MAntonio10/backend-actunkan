import { PartialType } from '@nestjs/mapped-types';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class CrearSectorDto {
  @IsNotEmpty({ message: 'El nombre del sector es obligatorio.' })
  @IsString({ message: 'El nombre debe ser una cadena de texto.' })
  @MinLength(3, { message: 'El nombre debe tener al menos 3 caracteres.' })
  @MaxLength(255, { message: 'El nombre no puede exceder los 255 caracteres.' })
  nombre: string;
}

export class ActualizarSectorDto extends PartialType(CrearSectorDto) {}
