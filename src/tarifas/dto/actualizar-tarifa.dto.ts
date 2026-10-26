import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  Max,
  Min,
} from 'class-validator';

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
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'El precio debe ser un número con máximo 4 decimales.' },
  )
  @Min(0, { message: 'El precio no puede ser negativo.' })
  @Max(99999999999999, { message: 'El precio excede el máximo permitido.' })
  precio: number;
}

export class ActualizarTarifaGuiaDto {
  @IsNotEmpty({ message: 'El precio del ticket de guía es obligatorio.' })
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'El precio debe ser un número con máximo 4 decimales.' },
  )
  @Min(0, { message: 'El precio no puede ser negativo.' })
  @Max(99999999999999, { message: 'El precio excede el máximo permitido.' })
  precio: number;
}

export class ActualizarDuracionRecorridoDto {
  @IsInt({ message: 'El ID de la atracción debe ser un número entero.' })
  @IsPositive({ message: 'El ID de la atracción debe ser positivo.' })
  idAtraccion: number;

  @IsInt({ message: 'El ID del tipo de recorrido debe ser un número entero.' })
  @IsPositive({ message: 'El ID del tipo de recorrido debe ser positivo.' })
  idTipoRecorrido: number;

  @IsInt({ message: 'La duración debe ser un número entero de minutos.' })
  @Min(1, { message: 'La duración debe ser de al menos 1 minuto.' })
  @Max(1440, { message: 'La duración no puede pasar de 24 horas.' })
  minutos: number;
}
