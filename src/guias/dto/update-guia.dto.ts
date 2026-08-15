import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Solo edición: el alta de guías ocurre dentro de `POST /tickets/emitir`
 * (bloque `guia.modo: "nuevo"`), no por un endpoint propio.
 */
export class UpdateGuiaDto {
  @IsOptional()
  @IsString({ message: 'El nombre del guía debe ser una cadena de texto.' })
  @MinLength(2, { message: 'El nombre del guía debe tener al menos 2 caracteres.' })
  @MaxLength(255, { message: 'El nombre del guía no puede exceder los 255 caracteres.' })
  nombre?: string;

  @IsOptional()
  @IsBoolean({ message: 'El campo tieneCarnet debe ser un valor booleano (true/false).' })
  tieneCarnet?: boolean;

  @IsOptional()
  @IsString({ message: 'El número de carnet debe ser una cadena de texto.' })
  @MaxLength(50, { message: 'El número de carnet no puede exceder los 50 caracteres.' })
  numeroCarnet?: string;
}
