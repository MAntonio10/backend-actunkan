import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryCierreDto {
  /** Filtra por el usuario que abrió la caja. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idUsuario?: number;

  @IsOptional()
  @IsString()
  fechaInicio?: string;

  @IsOptional()
  @IsString()
  fechaFin?: string;

  /** Solo cierres anulados: son la señal de que una caja se reabrió para corregir. */
  @IsOptional()
  @IsString()
  soloAnulados?: string;

  @IsOptional()
  @IsString()
  incluirAnulados?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'La página debe ser mayor o igual a 1.' })
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'El límite debe ser mayor o igual a 1.' })
  @Max(200, { message: 'El límite no puede exceder 200 registros por página.' })
  limite?: number;
}
