import { IsOptional, IsString, IsInt } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginacionQueryDto } from '../../common/dto/paginacion.dto';
import { PAGINACION_BITACORA } from '../../common/utils/paginacion.util';

export class QueryBitacoraDto extends PaginacionQueryDto(PAGINACION_BITACORA) {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idUsuario?: number;

  @IsOptional()
  @IsString()
  modulo?: string;

  @IsOptional()
  @IsString()
  accion?: string;

  @IsOptional()
  @IsString()
  fechaInicio?: string;

  @IsOptional()
  @IsString()
  fechaFin?: string;
}
