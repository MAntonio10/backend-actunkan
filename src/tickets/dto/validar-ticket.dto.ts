import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ValidarTicketDto {
  @IsNotEmpty({ message: 'El número de ticket es obligatorio.' })
  @IsString({ message: 'El número de ticket debe ser una cadena de texto.' })
  @MaxLength(30, {
    message: 'El número de ticket no puede exceder los 30 caracteres.',
  })
  numeroTicket: string;

  @IsNotEmpty({ message: 'La firma del código QR es obligatoria.' })
  @IsString({ message: 'La firma debe ser una cadena de texto.' })
  @MaxLength(128, { message: 'La firma no puede exceder los 128 caracteres.' })
  firma: string;

  /**
   * Taquilla que firmó el pase, cuando lo emitió sin conexión.
   *
   * Su ausencia significa que lo firmó el servidor, que es el caso normal: los
   * pases ya impresos y los lectores que no conocen este campo siguen validando
   * igual que antes.
   */
  @IsOptional()
  @IsString({
    message: 'El identificador del dispositivo debe ser una cadena de texto.',
  })
  @MaxLength(64, {
    message: 'El identificador no puede exceder los 64 caracteres.',
  })
  dispositivo?: string;
}
