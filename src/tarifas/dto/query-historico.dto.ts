import { Type } from 'class-transformer';
import { IsInt, IsOptional } from 'class-validator';
import { PaginacionQueryDto } from '../../common/dto/paginacion.dto';

/**
 * Se nombra por el endpoint y no por el recurso porque el módulo sirve dos
 * listados distintos, igual que `query-cierre.dto.ts` en cajas: el histórico se
 * pagina y el de tarifas vigentes no.
 */
export class QueryHistoricoDto extends PaginacionQueryDto() {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idAtraccion?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idOrigen?: number;
}
