import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class QueryDonacionDto {
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

export class AnularDonacionDto {
  /** Queda guardado en el recibo anulado y en la bitácora. */
  @IsOptional()
  @IsString({ message: 'El motivo debe ser una cadena de texto.' })
  @MaxLength(255, { message: 'El motivo no puede exceder los 255 caracteres.' })
  motivo?: string;
}
