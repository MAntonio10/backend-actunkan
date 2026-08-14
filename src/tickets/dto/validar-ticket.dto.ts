import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ValidarTicketDto {
  @IsNotEmpty({ message: 'El número de ticket es obligatorio.' })
  @IsString({ message: 'El número de ticket debe ser una cadena de texto.' })
  @MaxLength(30, { message: 'El número de ticket no puede exceder los 30 caracteres.' })
  numeroTicket: string;

  @IsNotEmpty({ message: 'La firma del código QR es obligatoria.' })
  @IsString({ message: 'La firma debe ser una cadena de texto.' })
  @MaxLength(128, { message: 'La firma no puede exceder los 128 caracteres.' })
  firma: string;
}
