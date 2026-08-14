import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryTicketDto {
  /** Búsqueda libre sobre nombre del grupo, folio y nombre del guía. */
  @IsOptional()
  @IsString()
  buscar?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idAtraccion?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idOpcionPago?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idOrigen?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idPais?: number;

  @IsOptional()
  @IsString()
  fechaInicio?: string;

  @IsOptional()
  @IsString()
  fechaFin?: string;

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
