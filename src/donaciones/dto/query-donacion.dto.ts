import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginacionQueryDto } from '../../common/dto/paginacion.dto';

export class QueryDonacionDto extends PaginacionQueryDto() {
  /** Busca por folio del recibo o nombre del donante. */
  @IsOptional()
  @IsString()
  buscar?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idUsuario?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idAperturaCaja?: number;

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

export class AnularDonacionDto {
  /** Queda guardado en el recibo anulado y en la bitácora. */
  @IsOptional()
  @IsString({ message: 'El motivo debe ser una cadena de texto.' })
  @MaxLength(255, { message: 'El motivo no puede exceder los 255 caracteres.' })
  motivo?: string;
}
