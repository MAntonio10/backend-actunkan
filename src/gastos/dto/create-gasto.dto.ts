import { IsInt, IsNotEmpty, IsNumber, IsPositive, IsString, MaxLength, Min } from 'class-validator';

export class CreateGastoDto {
  @IsNotEmpty({ message: 'El tipo de gasto es obligatorio.' })
  @IsInt({ message: 'El ID del tipo de gasto debe ser un número entero.' })
  @IsPositive({ message: 'El ID del tipo de gasto debe ser un número positivo.' })
  idTipoGasto: number;

  @IsNotEmpty({ message: 'La descripción del gasto es obligatoria.' })
  @IsString({ message: 'La descripción debe ser una cadena de texto.' })
  @MaxLength(255, { message: 'La descripción no puede exceder los 255 caracteres.' })
  descripcion: string;

  @IsNotEmpty({ message: 'El monto del gasto es obligatorio.' })
  @IsNumber({}, { message: 'El monto debe ser un número.' })
  @Min(0.01, { message: 'El monto debe ser mayor a 0.' })
  monto: number;
}
