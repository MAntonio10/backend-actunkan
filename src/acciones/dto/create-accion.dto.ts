import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateAccionDto {
  @IsNotEmpty({ message: 'El nombre de la acción es obligatorio (ej. ver, crear, editar, anular).' })
  @IsString({ message: 'El nombre de la acción debe ser una cadena de texto.' })
  @MaxLength(50, { message: 'El nombre de la acción no puede exceder los 50 caracteres.' })
  nombre: string;
}
