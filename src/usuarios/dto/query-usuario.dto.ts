import { IsOptional, IsString } from 'class-validator';
import { PaginacionQueryDto } from '../../common/dto/paginacion.dto';

export class QueryUsuarioDto extends PaginacionQueryDto() {
  /** 'true' suma los usuarios dados de baja al listado. */
  @IsOptional()
  @IsString()
  incluirAnulados?: string;
}
