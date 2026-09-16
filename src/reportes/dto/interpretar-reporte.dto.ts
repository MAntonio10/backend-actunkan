import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Petición de reporte en lenguaje natural.
 *
 * Es la única entrada del módulo que llega a salir del servidor, así que se acota: una
 * instrucción de mil caracteres no es una petición de reporte, es un intento de usar el
 * endpoint como si fuera un chat.
 */
export class InterpretarReporteDto {
  // Se recorta antes de medir: ocho espacios pasaban el mínimo de cinco
  // caracteres y llegaban al proveedor como una petición en blanco, gastando
  // una llamada de la cuota para no preguntar nada.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'Escriba qué reporte necesita.' })
  @IsString({ message: 'La instrucción debe ser texto.' })
  @MinLength(5, {
    message: 'La instrucción es demasiado corta para entenderla.',
  })
  @MaxLength(500, {
    message:
      'La instrucción no puede exceder los 500 caracteres. Describa en una frase qué ' +
      'información necesita y de qué período.',
  })
  // Al menos una letra. El ValidationPipe global convierte tipos de forma
  // implícita, así que un 12345 llegaba convertido en la cadena "12345", pasaba
  // el mínimo y se iba a interpretar. Una petición sin una sola letra no
  // describe ningún reporte.
  @Matches(/\p{L}/u, {
    message:
      'La instrucción debe describir con palabras qué reporte necesita.',
  })
  instruccion: string;
}
