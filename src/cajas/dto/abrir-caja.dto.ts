import { IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class AbrirCajaDto {
  @IsNotEmpty({ message: 'El monto inicial es obligatorio.' })
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'El monto inicial debe ser un número con máximo 4 decimales.' })
  @Min(0, { message: 'El monto inicial no puede ser negativo.' })
  @Max(99999999999999, { message: 'El monto inicial excede el máximo permitido.' })
  montoInicial: number;

  @IsOptional()
  @IsString({ message: 'Las observaciones deben ser una cadena de texto.' })
  @MaxLength(1000, { message: 'Las observaciones no pueden exceder los 1000 caracteres.' })
  observaciones?: string;
}
