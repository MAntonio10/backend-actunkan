import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CantidadPorCategoriaDto {
  @IsNotEmpty({ message: 'El tipo de visitante es obligatorio.' })
  @IsInt({ message: 'El ID del tipo de visitante debe ser un número entero.' })
  @IsPositive({ message: 'El ID del tipo de visitante debe ser positivo.' })
  idTipoVisitante: number;

  @IsInt({ message: 'La cantidad debe ser un número entero.' })
  @Min(0, { message: 'La cantidad no puede ser negativa.' })
  @Max(1000, { message: 'La cantidad no puede exceder 1000 por categoría.' })
  cantidad: number;
}

export class GuiaEmisionDto {
  @IsIn(['existente', 'nuevo'], { message: "El modo del guía debe ser 'existente' o 'nuevo'." })
  modo: 'existente' | 'nuevo';

  /** Requerido si modo = 'existente'. */
  @IsOptional()
  @IsInt({ message: 'El ID del guía debe ser un número entero.' })
  @IsPositive({ message: 'El ID del guía debe ser positivo.' })
  idGuia?: number;

  /** Requeridos si modo = 'nuevo'. */
  @IsOptional()
  @IsString({ message: 'El nombre del guía debe ser una cadena de texto.' })
  @MaxLength(255, { message: 'El nombre del guía no puede exceder los 255 caracteres.' })
  nombre?: string;

  @IsOptional()
  @IsBoolean({ message: 'El campo tieneCarnet debe ser booleano.' })
  tieneCarnet?: boolean;

  @IsOptional()
  @IsString({ message: 'El número de carnet debe ser una cadena de texto.' })
  @MaxLength(50, { message: 'El número de carnet no puede exceder los 50 caracteres.' })
  numeroCarnet?: string;

  /**
   * Forma de pago del ticket independiente del guía. Solo se usa cuando el guía
   * no tiene carnet; puede ser distinta a la del ticket del visitante.
   */
  @IsOptional()
  @IsInt({ message: 'El ID de la opción de pago del guía debe ser un número entero.' })
  @IsPositive({ message: 'El ID de la opción de pago del guía debe ser positivo.' })
  idOpcionPagoGuia?: number;
}

export class EmitirTicketDto {
  @IsNotEmpty({ message: 'El nombre del grupo es obligatorio.' })
  @IsString({ message: 'El nombre del grupo debe ser una cadena de texto.' })
  @MinLength(2, { message: 'El nombre del grupo debe tener al menos 2 caracteres.' })
  @MaxLength(255, { message: 'El nombre del grupo no puede exceder los 255 caracteres.' })
  nombreGrupo: string;

  @IsNotEmpty({ message: 'La atracción es obligatoria.' })
  @IsInt({ message: 'El ID de la atracción debe ser un número entero.' })
  @IsPositive({ message: 'El ID de la atracción debe ser positivo.' })
  idAtraccion: number;

  @IsNotEmpty({ message: 'El origen del visitante es obligatorio.' })
  @IsInt({ message: 'El ID del origen debe ser un número entero.' })
  @IsPositive({ message: 'El ID del origen debe ser positivo.' })
  idOrigen: number;

  /** Obligatorio cuando el origen es extranjero; se ignora si es nacional. */
  @IsOptional()
  @IsInt({ message: 'El ID del país debe ser un número entero.' })
  @IsPositive({ message: 'El ID del país debe ser positivo.' })
  idPais?: number;

  @IsNotEmpty({ message: 'El tipo de recorrido es obligatorio.' })
  @IsInt({ message: 'El ID del tipo de recorrido debe ser un número entero.' })
  @IsPositive({ message: 'El ID del tipo de recorrido debe ser positivo.' })
  idTipoRecorrido: number;

  @IsArray({ message: 'Las cantidades deben enviarse como un arreglo.' })
  @ArrayMinSize(1, { message: 'Debe indicar al menos una categoría de visitante.' })
  @ValidateNested({ each: true })
  @Type(() => CantidadPorCategoriaDto)
  cantidades: CantidadPorCategoriaDto[];

  @IsNotEmpty({ message: 'La forma de pago es obligatoria.' })
  @IsInt({ message: 'El ID de la opción de pago debe ser un número entero.' })
  @IsPositive({ message: 'El ID de la opción de pago debe ser positivo.' })
  idOpcionPago: number;

  @IsOptional()
  @IsString({ message: 'Las notas deben ser una cadena de texto.' })
  @MaxLength(1000, { message: 'Las notas no pueden exceder los 1000 caracteres.' })
  notas?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GuiaEmisionDto)
  guia?: GuiaEmisionDto;
}
