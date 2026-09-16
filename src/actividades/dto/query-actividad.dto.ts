import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { PaginacionQueryDto } from '../../common/dto/paginacion.dto';
import { PAGINACION_ACTIVIDADES } from '../../common/utils/paginacion.util';

export class QueryActividadDto extends PaginacionQueryDto(PAGINACION_ACTIVIDADES) {
  /** Busca en nombre y descripción. */
  @IsOptional()
  @IsString()
  buscar?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idSectorParque?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idUsuarioAutor?: number;

  /**
   * @deprecated Sin efecto. Las publicaciones propias fuera de su ventana ya
   * vienen siempre en el listado, y las ajenas no se muestran nunca. Se conserva
   * para no romper a los clientes que aún lo envían (`forbidNonWhitelisted`
   * rechazaría la petición con 400 si se quitara).
   */
  @IsOptional()
  @IsString()
  incluirExpiradas?: string;

  /** 'true' suma las publicaciones anuladas **propias**; las ajenas nunca. */
  @IsOptional()
  @IsString()
  incluirAnuladas?: string;

  /**
   * 'true' devuelve **solo** las anuladas, para la papelera del autor.
   * Tiene prioridad sobre `incluirAnuladas`, igual que en el historial de cierres
   * de caja. Como las anuladas ajenas no se muestran nunca, equivale a
   * "mis publicaciones anuladas".
   */
  @IsOptional()
  @IsString()
  soloAnuladas?: string;

  /** 'true' devuelve solo las publicaciones del usuario autenticado. */
  @IsOptional()
  @IsString()
  soloMias?: string;
}
