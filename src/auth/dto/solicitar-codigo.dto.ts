import { IsEmail, IsNotEmpty } from 'class-validator';

export class SolicitarCodigoDto {
  @IsNotEmpty({ message: 'El correo electrónico es obligatorio.' })
  @IsEmail({}, { message: 'El correo electrónico provisto no tiene un formato válido (ej. usuario@dominio.com).' })
  correo: string;
}
