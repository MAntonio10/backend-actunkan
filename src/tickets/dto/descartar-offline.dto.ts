import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsIn,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Un cobro hecho sin conexión que la taquilla descartó antes de subirlo. */
export class DescarteOfflineDto {
  @IsNotEmpty({ message: 'El número de ticket es obligatorio.' })
  @IsString({ message: 'El número de ticket debe ser una cadena de texto.' })
  @MaxLength(30, {
    message: 'El número de ticket no puede exceder 30 caracteres.',
  })
  numeroTicket: string;

  /**
   * La firma del propio folio. Es lo que impide declarar como descartado un folio
   * ajeno: sin la llave de esa taquilla no se puede producir.
   */
  @IsNotEmpty({ message: 'La firma del folio es obligatoria.' })
  @IsString({ message: 'La firma debe ser una cadena de texto.' })
  @MaxLength(128, { message: 'La firma no puede exceder 128 caracteres.' })
  firma: string;

  /**
   * Lo que se declara haber cobrado. Viaja como texto para no perder centavos en el
   * punto flotante de JSON, igual que en la emisión.
   */
  @IsNotEmpty({ message: 'El monto cobrado es obligatorio.' })
  @IsNumberString(
    {},
    { message: 'El monto cobrado debe ser un número en formato texto.' },
  )
  montoCobrado: string;

  @IsNotEmpty({ message: 'La fecha del descarte es obligatoria.' })
  @IsDateString(
    {},
    { message: 'La fecha del descarte debe ser una fecha válida (ISO 8601).' },
  )
  fechaDescarte: string;

  /**
   * 'DESCARTADO' (un cobro ya hecho que se tira) o 'ANULADO' (una venta que no
   * llegó a existir). Los dos liberan el folio, pero solo el primero implica dinero
   * que alguien tiene que explicar. Por omisión se asume el caso grave.
   */
  @IsOptional()
  @IsIn(['DESCARTADO', 'ANULADO'], {
    message: "El tipo debe ser 'DESCARTADO' o 'ANULADO'.",
  })
  tipo?: 'DESCARTADO' | 'ANULADO';

  @IsOptional()
  @IsString({ message: 'El motivo debe ser una cadena de texto.' })
  @MaxLength(255, { message: 'El motivo no puede exceder 255 caracteres.' })
  motivo?: string;
}

/**
 * Declaración de cobros descartados sin conexión.
 *
 * Descartar ocurre en el dispositivo y el servidor no puede impedirlo: esa venta
 * nunca llegó aquí. Lo que sí puede es exigir que se declare, dejar constancia del
 * monto y comprobar el permiso. Sin esto, es la única operación del sistema donde
 * desaparece dinero sin que quede rastro en ninguna parte.
 */
export class DeclararDescartesDto {
  @IsNotEmpty({ message: 'El dispositivo es obligatorio.' })
  @IsString({
    message: 'El identificador del dispositivo debe ser una cadena de texto.',
  })
  @MaxLength(64, {
    message: 'El identificador no puede exceder 64 caracteres.',
  })
  dispositivo: string;

  @IsNotEmpty({ message: 'La apertura de caja es obligatoria.' })
  @IsInt({ message: 'El ID de la apertura de caja debe ser un número entero.' })
  @IsPositive({ message: 'El ID de la apertura de caja debe ser positivo.' })
  idAperturaCaja: number;

  @IsArray({ message: 'Los descartes deben enviarse como un arreglo.' })
  @ArrayMinSize(1, { message: 'Debe enviar al menos un descarte.' })
  @ArrayMaxSize(50, {
    message: 'No se pueden declarar más de 50 descartes por llamada.',
  })
  @ValidateNested({ each: true })
  @Type(() => DescarteOfflineDto)
  descartes: DescarteOfflineDto[];
}
