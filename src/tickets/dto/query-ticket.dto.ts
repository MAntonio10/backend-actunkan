import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { PaginacionQueryDto } from '../../common/dto/paginacion.dto';

export class QueryTicketDto extends PaginacionQueryDto() {
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
}
