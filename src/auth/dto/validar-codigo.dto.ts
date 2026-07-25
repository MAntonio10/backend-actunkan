import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

export class ValidarCodigoDto {
  @IsNotEmpty({ message: 'El correo electrónico es obligatorio.' })
  @IsEmail({}, { message: 'El correo electrónico provisto no tiene un formato válido.' })
  correo: string;

  @IsNotEmpty({ message: 'El código de verificación es obligatorio.' })
  @IsString({ message: 'El código debe ser una cadena de caracteres.' })
  @Length(6, 6, { message: 'El código de verificación debe contener exactamente 6 dígitos.' })
  codigo: string;
}
