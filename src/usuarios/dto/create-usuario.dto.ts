import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateUsuarioDto {
  @IsNotEmpty({ message: 'El nombre del usuario es obligatorio.' })
  @IsString({ message: 'El nombre debe ser una cadena de texto.' })
  nombre: string;

  @IsNotEmpty({ message: 'El correo electrónico es obligatorio.' })
  @IsEmail({}, { message: 'El correo electrónico provisto no tiene un formato válido (ej. usuario@dominio.com).' })
  correo: string;

  @IsNotEmpty({ message: 'La contraseña es obligatoria.' })
  @IsString({ message: 'La contraseña debe ser una cadena de texto.' })
  @MinLength(6, { message: 'La contraseña debe contener al menos 6 caracteres por seguridad.' })
  contrasena: string;

  @IsNotEmpty({ message: 'El puesto del usuario (idPuesto) es obligatorio.' })
  @IsInt({ message: 'El ID del puesto debe ser un número entero.' })
  @Min(1, { message: 'El ID del puesto debe ser un ID válido mayor a 0.' })
  idPuesto: number;

  @IsOptional()
  @IsString({ message: 'El teléfono debe ser una cadena de texto.' })
  telefono?: string;
}
