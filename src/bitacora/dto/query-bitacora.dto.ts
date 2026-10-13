import { IsIn, IsOptional, IsString, IsInt } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginacionQueryDto } from '../../common/dto/paginacion.dto';
import { PAGINACION_BITACORA } from '../../common/utils/paginacion.util';

export class QueryBitacoraDto extends PaginacionQueryDto(PAGINACION_BITACORA) {
  /**
   * Búsqueda libre sobre descripción, acción, módulo, nombre y correo del
   * ejecutor. Va del lado del servidor a propósito: filtrar en el navegador
   * solo alcanzaría la página cargada, y la bitácora tiene un histórico muy por
   * encima de lo que cabe en una página.
   */
  @IsOptional()
  @IsString()
  buscar?: string;

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

  /**
   * Sentido del orden por fecha. `desc` (lo más reciente primero) por omisión,
   * que es como se lee una bitácora.
   *
   * Existe porque con la paginación en el servidor el frontend ya no puede
   * ofrecerlo: invertir el arreglo recibido solo reordena la página visible, y el
   * control mentiría —diría «más antiguo primero» mostrando los 20 registros más
   * recientes al revés—. Rastrear una secuencia de eventos desde su inicio es un
   * uso legítimo de un histórico, así que el orden lo decide quien consulta.
   */
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: "El orden debe ser 'asc' o 'desc'." })
  orden?: 'asc' | 'desc';
}
