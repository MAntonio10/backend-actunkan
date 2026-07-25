import { ArrayNotEmpty, IsArray, IsInt, Min } from 'class-validator';

export class AssignPermisosDto {
  @IsArray({ message: 'El campo idsModuloAccion debe ser una lista de números enteros.' })
  @ArrayNotEmpty({ message: 'Debe proporcionar al menos un ID de MóduloAcción para asignar o reemplazar permisos.' })
  @IsInt({ each: true, message: 'Cada elemento de la lista debe ser un número entero válido.' })
  @Min(1, { each: true, message: 'Cada ID de MóduloAcción debe ser mayor a 0.' })
  idsModuloAccion: number[];
}
