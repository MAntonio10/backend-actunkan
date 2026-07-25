import { IsOptional, IsString, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryBitacoraDto {
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limite?: number;
}
