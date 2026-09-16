import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  PAGINACION_POR_DEFECTO,
  type OpcionesPaginacion,
  type PaginacionQuery,
} from '../utils/paginacion.util';

/**
 * Clase base de los DTO de consulta paginados.
 *
 * POR QUÉ UNA FUNCIÓN Y NO UNA CLASE SUELTA
 * -----------------------------------------
 * El tope no es el mismo en todos los módulos: actividades pagina a 100 y el resto
 * a 200. Con una clase fija habría que redeclarar `@Max` en cada subclase que se
 * salga de la norma, y entonces el número quedaría escrito tres veces —en el
 * decorador, en el mensaje de error y en las opciones que recibe el servicio— con
 * tres oportunidades de que se separen.
 *
 * Recibiendo el mismo objeto `OpcionesPaginacion` que consume `resolverPaginacion`,
 * el tope se define UNA vez y alimenta el validador, el mensaje y el recorte en
 * tiempo de ejecución.
 *
 * Es el mismo recurso que `PartialType` de `@nestjs/mapped-types`, ya usado en seis
 * DTO del proyecto: una función que devuelve la clase de la que se hereda.
 *
 * El tipo de retorno se escribe `new () => PaginacionQuery` en lugar de importar
 * `Type` de `@nestjs/common` porque ese nombre ya lo ocupa el `Type` de
 * `class-transformer` que usan los decoradores de abajo.
 */
export function PaginacionQueryDto(
  opciones: OpcionesPaginacion = PAGINACION_POR_DEFECTO,
): new () => PaginacionQuery {
  class Paginacion implements PaginacionQuery {
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: 'La página debe ser un número entero.' })
    @Min(1, { message: 'La página debe ser mayor o igual a 1.' })
    pagina?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: 'El límite debe ser un número entero.' })
    @Min(1, { message: 'El límite debe ser mayor o igual a 1.' })
    @Max(opciones.limiteMaximo, {
      message: `El límite no puede exceder ${opciones.limiteMaximo} registros por página.`,
    })
    limite?: number;
  }

  return Paginacion;
}
