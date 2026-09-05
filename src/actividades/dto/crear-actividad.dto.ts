import { PartialType } from '@nestjs/mapped-types';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CrearActividadDto {
  @IsNotEmpty({ message: 'El nombre de la actividad es obligatorio.' })
  @IsString({ message: 'El nombre debe ser una cadena de texto.' })
  @MinLength(3, { message: 'El nombre debe tener al menos 3 caracteres.' })
  @MaxLength(255, { message: 'El nombre no puede exceder los 255 caracteres.' })
  nombreActividad: string;

  @IsNotEmpty({ message: 'La descripción es obligatoria.' })
  @IsString({ message: 'La descripción debe ser una cadena de texto.' })
  @MaxLength(5000, { message: 'La descripción no puede exceder los 5000 caracteres.' })
  descripcionActividad: string;

  /** Desde cuándo se muestra a los demás usuarios. */
  @IsNotEmpty({ message: 'La fecha de inicio es obligatoria.' })
  @IsDateString({}, { message: 'La fecha de inicio debe ser una fecha válida (ISO 8601).' })
  fechaInicio: string;

  /** Hasta cuándo se muestra. Sin ella, la publicación no expira. */
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de fin debe ser una fecha válida (ISO 8601).' })
  fechaFin?: string;

  @IsOptional()
  @IsInt({ message: 'El ID del sector debe ser un número entero.' })
  @IsPositive({ message: 'El ID del sector debe ser positivo.' })
  idSectorParque?: number;

  /** Encargado de ejecutarla, distinto de quien publica. */
  @IsOptional()
  @IsInt({ message: 'El ID del responsable debe ser un número entero.' })
  @IsPositive({ message: 'El ID del responsable debe ser positivo.' })
  idUsuarioResponsable?: number;
}

/** El autor no se puede cambiar: define quién puede editar y anular. */
export class ActualizarActividadDto extends PartialType(CrearActividadDto) {}
