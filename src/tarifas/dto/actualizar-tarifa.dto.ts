import { IsInt, IsNotEmpty, IsNumber, IsPositive, Max, Min } from 'class-validator';

export class ActualizarTarifaDto {
  @IsNotEmpty({ message: 'La atracción es obligatoria.' })
  @IsInt({ message: 'El ID de la atracción debe ser un número entero.' })
  @IsPositive({ message: 'El ID de la atracción debe ser positivo.' })
  idAtraccion: number;

  @IsNotEmpty({ message: 'El origen del visitante es obligatorio.' })
  @IsInt({ message: 'El ID del origen debe ser un número entero.' })
  @IsPositive({ message: 'El ID del origen debe ser positivo.' })
  idOrigen: number;

  @IsNotEmpty({ message: 'El tipo de visitante es obligatorio.' })
  @IsInt({ message: 'El ID del tipo de visitante debe ser un número entero.' })
  @IsPositive({ message: 'El ID del tipo de visitante debe ser positivo.' })
  idTipoVisitante: number;

  @IsNotEmpty({ message: 'El precio es obligatorio.' })
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'El precio debe ser un número con máximo 4 decimales.' })
  @Min(0, { message: 'El precio no puede ser negativo.' })
  @Max(99999999999999, { message: 'El precio excede el máximo permitido.' })
  precio: number;
}

export class ActualizarTarifaGuiaDto {
  @IsNotEmpty({ message: 'El precio del ticket de guía es obligatorio.' })
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'El precio debe ser un número con máximo 4 decimales.' })
  @Min(0, { message: 'El precio no puede ser negativo.' })
  @Max(99999999999999, { message: 'El precio excede el máximo permitido.' })
  precio: number;
}
