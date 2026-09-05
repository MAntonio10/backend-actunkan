import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CrearLoteOfflineDto {
  /**
   * Lotes chicos limitan el daño si se pierde el dispositivo: cada folio no
   * utilizado deja un hueco permanente en la numeración.
   */
  @IsNotEmpty({ message: 'La cantidad de folios es obligatoria.' })
  @IsInt({ message: 'La cantidad debe ser un número entero.' })
  @Min(1, { message: 'Debe reservar al menos 1 folio.' })
  @Max(200, { message: 'No se pueden reservar más de 200 folios por lote.' })
  cantidad: number;

  /** UUID persistente que genera el navegador del dispositivo de taquilla. */
  @IsNotEmpty({ message: 'El identificador del dispositivo es obligatorio.' })
  @IsString({ message: 'El identificador del dispositivo debe ser una cadena de texto.' })
  @MaxLength(64, { message: 'El identificador del dispositivo no puede exceder 64 caracteres.' })
  idDispositivo: string;
}

export class QueryLoteActivoDto {
  @IsNotEmpty({ message: 'El identificador del dispositivo es obligatorio.' })
  @IsString({ message: 'El identificador del dispositivo debe ser una cadena de texto.' })
  @MaxLength(64, { message: 'El identificador del dispositivo no puede exceder 64 caracteres.' })
  idDispositivo: string;
}

/**
 * Lo que el dispositivo declara haber hecho. Sirve de contraste contra lo que el
 * servidor registró: si declara vendido un folio del que no hay ticket, esa venta
 * se perdió y hay que investigarla.
 */
export class ConciliarLoteDto {
  @IsOptional()
  @IsArray({ message: 'Los folios utilizados deben enviarse como un arreglo.' })
  @ArrayMaxSize(200, { message: 'No se pueden declarar más de 200 folios.' })
  @IsString({ each: true, message: 'Cada folio debe ser una cadena de texto.' })
  foliosUtilizados?: string[];

  @IsOptional()
  @IsArray({ message: 'Los folios no utilizados deben enviarse como un arreglo.' })
  @ArrayMaxSize(200, { message: 'No se pueden declarar más de 200 folios.' })
  @IsString({ each: true, message: 'Cada folio debe ser una cadena de texto.' })
  foliosNoUtilizados?: string[];
}
