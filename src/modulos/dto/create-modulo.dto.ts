import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateModuloDto {
  @IsNotEmpty({ message: 'El nombre del módulo es obligatorio.' })
  @IsString({ message: 'El nombre del módulo debe ser una cadena de texto.' })
  @MaxLength(100, { message: 'El nombre del módulo no puede exceder los 100 caracteres.' })
  nombre: string;
}
