import { Transform } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  CLAVES_AGRUPACION,
  DIAS_SEMANA_CLAVE,
  METRICAS,
} from '../consultas/dimensiones';

/**
 * Filtros de un reporte.
 *
 * **Todos los campos son texto a propósito.** Por esta misma clase pasan dos entradas
 * distintas: el frontend, que manda ids porque ya tiene los catálogos, y la IA, que manda
 * nombres porque nunca los vio. `ResolutorFiltrosService` acepta las dos formas y
 * devuelve ids en ambos casos, así que la validación de aquí en adelante es idéntica.
 *
 * Es también el DTO que valida la respuesta de la IA: si divergiera del que usa la ruta
 * manual, una petición en lenguaje natural podría colar un filtro que la ruta normal
 * rechaza.
 */
export class GenerarReporteDto {
  @IsOptional()
  @IsString({
    message: 'La fecha inicial debe ser texto en formato AAAA-MM-DD.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'La fecha inicial debe tener el formato AAAA-MM-DD.',
  })
  desde?: string;

  @IsOptional()
  @IsString({ message: 'La fecha final debe ser texto en formato AAAA-MM-DD.' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'La fecha final debe tener el formato AAAA-MM-DD.',
  })
  hasta?: string;

  @IsOptional()
  @IsString({ message: 'El vendedor debe ser un nombre o un identificador.' })
  @MaxLength(255, {
    message: 'El vendedor no puede exceder los 255 caracteres.',
  })
  vendedor?: string;

  @IsOptional()
  @IsString({ message: 'La atracción debe ser un nombre o un identificador.' })
  @MaxLength(255, {
    message: 'La atracción no puede exceder los 255 caracteres.',
  })
  atraccion?: string;

  @IsOptional()
  @IsString({ message: 'El origen debe ser un nombre o un identificador.' })
  @MaxLength(255, { message: 'El origen no puede exceder los 255 caracteres.' })
  origen?: string;

  @IsOptional()
  @IsString({ message: 'El país debe ser un nombre o un identificador.' })
  @MaxLength(255, { message: 'El país no puede exceder los 255 caracteres.' })
  pais?: string;

  @IsOptional()
  @IsString({ message: 'La guía debe ser un nombre o un identificador.' })
  @MaxLength(255, { message: 'La guía no puede exceder los 255 caracteres.' })
  guia?: string;

  @IsOptional()
  @IsString({
    message: 'El tipo de visitante debe ser un nombre o un identificador.',
  })
  @MaxLength(255, {
    message: 'El tipo de visitante no puede exceder los 255 caracteres.',
  })
  tipoVisitante?: string;

  @IsOptional()
  @IsString({
    message: 'El tipo de recorrido debe ser un nombre o un identificador.',
  })
  @MaxLength(255, {
    message: 'El tipo de recorrido no puede exceder los 255 caracteres.',
  })
  tipoRecorrido?: string;

  @IsOptional()
  @IsString({
    message: 'La forma de pago debe ser un nombre o un identificador.',
  })
  @MaxLength(255, {
    message: 'La forma de pago no puede exceder los 255 caracteres.',
  })
  formaPago?: string;

  @IsOptional()
  @IsString({ message: 'La caja debe ser un identificador numérico.' })
  @MaxLength(20, { message: 'El identificador de caja no es válido.' })
  caja?: string;

  @IsOptional()
  @IsString({ message: 'El sector debe ser un nombre o un identificador.' })
  @MaxLength(255, { message: 'El sector no puede exceder los 255 caracteres.' })
  sector?: string;

  @IsOptional()
  @IsString({ message: 'El módulo debe ser texto.' })
  @MaxLength(100, { message: 'El módulo no puede exceder los 100 caracteres.' })
  modulo?: string;

  @IsOptional()
  @IsString({ message: 'La acción debe ser texto.' })
  @MaxLength(100, { message: 'La acción no puede exceder los 100 caracteres.' })
  accion?: string;

  @IsOptional()
  // Llega como texto desde la query string y como booleano desde la IA; se normaliza
  // antes de validar para que las dos formas pasen por la misma regla.
  @Transform(({ value }) =>
    typeof value === 'boolean' ? String(value) : value,
  )
  @IsBooleanString({ message: 'Incluir anulados debe ser true o false.' })
  incluirAnulados?: string;

  // --- Reporte a medida ---
  // Solo los usa 'ventas-a-medida'. Viven en este DTO y no en uno aparte porque
  // es el mismo que valida la respuesta de la IA: un DTO propio permitiría que
  // la vía escrita pidiera algo que la ruta manual rechaza.

  @IsOptional()
  @IsString({ message: 'La dimensión debe ser texto.' })
  @IsIn(CLAVES_AGRUPACION, {
    message: `La dimensión debe ser una de: ${CLAVES_AGRUPACION.join(', ')}.`,
  })
  dimension?: string;

  @IsOptional()
  @IsString({ message: 'La segunda dimensión debe ser texto.' })
  @IsIn(CLAVES_AGRUPACION, {
    message: `La segunda dimensión debe ser una de: ${CLAVES_AGRUPACION.join(', ')}.`,
  })
  dimension2?: string;

  /**
   * Día de la semana, por nombre. Solo lo acepta `ventas-a-medida`: es el único
   * cuyas consultas van en SQL y pueden truncar la fecha. El resto calcula sus
   * cifras con agregados de Prisma, que no saben expresarlo, y el servicio
   * rechaza el filtro antes de que llegue a uno de ellos.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .trim()
          .toLocaleLowerCase('es')
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
      : value,
  )
  @IsIn(DIAS_SEMANA_CLAVE, {
    message: `El día de la semana debe ser uno de: ${DIAS_SEMANA_CLAVE.join(', ')}.`,
  })
  diaSemana?: string;

  /**
   * Grano de las series del panel. Va en este DTO porque el ValidationPipe
   * global rechaza lo que no esté declarado aquí; como ningún reporte lo
   * declara en su catálogo, la comprobación de parámetros lo rechaza en todos
   * ellos y solo el panel lo acepta.
   */
  @IsOptional()
  @IsString({ message: 'El grano debe ser texto.' })
  @IsIn(['dia', 'semana', 'mes'], {
    message: 'El grano debe ser uno de: dia, semana, mes.',
  })
  grano?: string;

  @IsOptional()
  @IsString({ message: 'La métrica debe ser texto.' })
  @IsIn(METRICAS, { message: `La métrica debe ser una de: ${METRICAS.join(', ')}.` })
  metrica?: string;

  @IsOptional()
  // La IA suele mandarlo como número y la query string siempre como texto.
  @Transform(({ value }) => (typeof value === 'number' ? String(value) : value))
  @Matches(/^\d{1,3}$/, {
    message: 'El tope debe ser un número entero de hasta tres cifras.',
  })
  tope?: string;
}
