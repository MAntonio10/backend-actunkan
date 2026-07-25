import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePuestoDto {
  @IsNotEmpty({ message: 'El nombre del puesto es obligatorio.' })
  @IsString({ message: 'El nombre del puesto debe ser una cadena de texto.' })
  @MaxLength(100, { message: 'El nombre del puesto no puede exceder los 100 caracteres.' })
  nombre: string;

  @IsOptional()
  @IsString({ message: 'La descripción debe ser una cadena de texto.' })
  descripcion?: string;
}
