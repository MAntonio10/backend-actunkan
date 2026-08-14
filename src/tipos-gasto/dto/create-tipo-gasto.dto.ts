import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateTipoGastoDto {
  @IsNotEmpty({ message: 'El nombre del tipo de gasto es obligatorio.' })
  @IsString({ message: 'El nombre del tipo de gasto debe ser una cadena de texto.' })
  @MaxLength(255, { message: 'El nombre del tipo de gasto no puede exceder los 255 caracteres.' })
  nombre: string;
}
