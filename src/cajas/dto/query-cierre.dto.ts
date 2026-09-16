import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { PaginacionQueryDto } from '../../common/dto/paginacion.dto';

export class QueryCierreDto extends PaginacionQueryDto() {
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
}
