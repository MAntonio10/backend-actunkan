import {
  IsBase64,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class RegistrarDispositivoDto {
  /** Identificador estable que genera el navegador y guarda en IndexedDB. */
  @IsString()
  @IsNotEmpty({ message: 'El identificador del dispositivo es obligatorio.' })
  @MaxLength(64, {
    message: 'El identificador no puede exceder 64 caracteres.',
  })
  idDispositivo: string;

  /** Nombre visible para el administrador ('Taquilla 1'). */
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres.' })
  nombre?: string;

  /**
   * Llave pública ECDSA P-256 exportada en SPKI y codificada en base64.
   * La privada se queda en el navegador y no se envía nunca.
   */
  @IsString()
  @IsNotEmpty({ message: 'La llave pública es obligatoria.' })
  @IsBase64({}, { message: 'La llave pública debe venir en base64.' })
  llavePublica: string;
}
