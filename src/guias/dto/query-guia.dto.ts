import { IsOptional, IsString } from 'class-validator';
import { PaginacionQueryDto } from '../../common/dto/paginacion.dto';

export class QueryGuiaDto extends PaginacionQueryDto() {
  /** Busca por nombre del guía. */
  @IsOptional()
  @IsString()
  buscar?: string;

  /** 'true' suma los guías dados de baja al listado. */
  @IsOptional()
  @IsString()
  incluirAnulados?: string;
}
