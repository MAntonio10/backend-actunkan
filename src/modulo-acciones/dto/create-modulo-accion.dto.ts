import { IsInt, IsNotEmpty, Min } from 'class-validator';

export class CreateModuloAccionDto {
  @IsNotEmpty({ message: 'El ID del módulo es obligatorio.' })
  @IsInt({ message: 'El ID del módulo debe ser un número entero.' })
  @Min(1, { message: 'El ID del módulo debe ser mayor a 0.' })
  idModulo: number;

  @IsNotEmpty({ message: 'El ID de la acción es obligatorio.' })
  @IsInt({ message: 'El ID de la acción debe ser un número entero.' })
  @Min(1, { message: 'El ID de la acción debe ser mayor a 0.' })
  idAccion: number;
}
