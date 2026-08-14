import { IsOptional, IsString } from 'class-validator';

export class QueryCajaDto {
  @IsOptional()
  @IsString()
  estado?: string;

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
