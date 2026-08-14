import { IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CerrarCajaDto {
  @IsNotEmpty({ message: 'El monto contado es obligatorio.' })
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'El monto contado debe ser un número con máximo 4 decimales.' })
  @Min(0, { message: 'El monto contado no puede ser negativo.' })
  @Max(99999999999999, { message: 'El monto contado excede el máximo permitido.' })
  montoContado: number;

  @IsOptional()
  @IsString({ message: 'Las observaciones deben ser una cadena de texto.' })
  @MaxLength(1000, { message: 'Las observaciones no pueden exceder los 1000 caracteres.' })
  observaciones?: string;
}
