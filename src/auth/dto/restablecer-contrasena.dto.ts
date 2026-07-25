import { IsEmail, IsNotEmpty, IsString, Length, MinLength } from 'class-validator';

export class RestablecerContrasenaDto {
  @IsNotEmpty({ message: 'El correo electrónico es obligatorio.' })
  @IsEmail({}, { message: 'El correo electrónico provisto no tiene un formato válido.' })
  correo: string;

  @IsNotEmpty({ message: 'El código de verificación es obligatorio.' })
  @IsString({ message: 'El código debe ser una cadena de caracteres.' })
  @Length(6, 6, { message: 'El código de verificación debe contener exactamente 6 dígitos.' })
  codigo: string;

  @IsNotEmpty({ message: 'La nueva contraseña es obligatoria.' })
  @IsString({ message: 'La nueva contraseña debe ser una cadena de texto.' })
  @MinLength(6, { message: 'La nueva contraseña debe tener al menos 6 caracteres por seguridad.' })
  nuevaContrasena: string;
}
