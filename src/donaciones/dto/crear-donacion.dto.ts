import { IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CrearDonacionDto {
  @IsNotEmpty({ message: 'El monto de la donación es obligatorio.' })
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'El monto debe ser un número con máximo 4 decimales.' })
  @Min(0.01, { message: 'El monto de la donación debe ser mayor a 0.' })
  @Max(99999999999999, { message: 'El monto excede el máximo permitido.' })
  monto: number;

  /** Opcional: se admiten donaciones anónimas. */
  @IsOptional()
  @IsString({ message: 'El nombre del donante debe ser una cadena de texto.' })
  @MaxLength(255, { message: 'El nombre del donante no puede exceder los 255 caracteres.' })
  nombreDonante?: string;

  @IsOptional()
  @IsString({ message: 'Las observaciones deben ser una cadena de texto.' })
  @MaxLength(1000, { message: 'Las observaciones no pueden exceder los 1000 caracteres.' })
  observaciones?: string;
}
