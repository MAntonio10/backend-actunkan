import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * Destinatario del enlace de pago.
 *
 * Solo el correo: el enlace lo pone el servidor leyéndolo del pago guardado. Si
 * también llegara desde el cliente, este endpoint sería un relé para mandar
 * cualquier URL a cualquier buzón con el remitente del parque.
 */
export class EnviarEnlacePagoDto {
  // Se normaliza antes de validar: en taquilla se escribe con mayúsculas y con
  // espacios de sobra al copiar y pegar, y ninguna de las dos cosas cambia a
  // quién llega el correo.
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsNotEmpty({ message: 'Escriba el correo al que se enviará el enlace de pago.' })
  @IsEmail({}, { message: 'El correo electrónico no tiene un formato válido.' })
  @MaxLength(255, { message: 'El correo no puede exceder los 255 caracteres.' })
  correo: string;
}
