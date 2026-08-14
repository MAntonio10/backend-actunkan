import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @IsNotEmpty({ message: 'El refresh token es obligatorio.' })
  @IsString({ message: 'El refresh token debe ser una cadena de texto.' })
  @MaxLength(200, { message: 'El refresh token no tiene un formato válido.' })
  refresh_token: string;
}
