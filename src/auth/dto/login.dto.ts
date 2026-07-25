import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsNotEmpty({ message: 'El correo electrónico es obligatorio para iniciar sesión.' })
  @IsEmail({}, { message: 'Debe ingresar un correo electrónico con formato válido (ej. usuario@dominio.com).' })
  correo: string;

  @IsNotEmpty({ message: 'La contraseña es obligatoria para iniciar sesión.' })
  @IsString({ message: 'La contraseña debe ser una cadena de texto.' })
  contrasena: string;

  @IsOptional()
  @IsBoolean({ message: 'El campo recordarme debe ser un valor booleano (true/false).' })
  recordarme?: boolean;
}
