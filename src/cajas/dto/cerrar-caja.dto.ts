import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CerrarCajaDto {
  @IsNotEmpty({ message: 'El monto contado es obligatorio.' })
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'El monto contado debe ser un número con máximo 4 decimales.' })
  @Min(0, { message: 'El monto contado no puede ser negativo.' })
  @Max(99999999999999, { message: 'El monto contado excede el máximo permitido.' })
  montoContado: number;

  @IsOptional()
  @IsString({ message: 'Las observaciones deben ser una cadena de texto.' })
  @MaxLength(1000, { message: 'Las observaciones no pueden exceder los 1000 caracteres.' })
  observaciones?: string;

  /**
   * Salida de emergencia para cerrar con un lote offline todavía activo.
   *
   * **Invalida el lote**, así que las ventas que el dispositivo no haya subido se
   * pierden: ese dinero queda cobrado sin ticket que lo respalde. Exige permiso
   * `Cajas.Editar` (supervisión), no `Anular`: con `Anular` —que el cajero tiene—
   * podría descartar sus propias ventas pendientes y cerrar la caja sin ellas.
   */
  @IsOptional()
  @IsBoolean({ message: 'forzarLoteOffline debe ser booleano.' })
  forzarLoteOffline?: boolean;
}
