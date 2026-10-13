import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { EmitirTicketDto } from './emitir-ticket.dto';

/**
 * Una venta hecha sin conexión. Es el payload de `POST /tickets/emitir` más lo que
 * solo existe en el mundo offline: la clave de idempotencia, los folios que el
 * dispositivo ya consumió, cuándo ocurrió de verdad y cuánto se cobró.
 */
export class VentaOfflineDto extends EmitirTicketDto {
  /**
   * Clave de idempotencia que genera el dispositivo. Es lo que permite reintentar
   * la subida tras un timeout ambiguo sin duplicar el ticket.
   */
  @IsNotEmpty({
    message:
      'El idLocal es obligatorio: sin él no se puede reintentar sin duplicar.',
  })
  @IsString({ message: 'El idLocal debe ser una cadena de texto.' })
  @MaxLength(36, { message: 'El idLocal no puede exceder 36 caracteres.' })
  idLocal: string;

  /** Folio reservado que el dispositivo ya imprimió en el pase del visitante. */
  @IsNotEmpty({ message: 'El número de ticket es obligatorio.' })
  @IsString({ message: 'El número de ticket debe ser una cadena de texto.' })
  @MaxLength(30, {
    message: 'El número de ticket no puede exceder 30 caracteres.',
  })
  numeroTicket: string;

  /** Segundo folio, solo cuando la venta lleva guía sin carnet. */
  @IsOptional()
  @IsString({
    message: 'El número de ticket del guía debe ser una cadena de texto.',
  })
  @MaxLength(30, {
    message: 'El número de ticket del guía no puede exceder 30 caracteres.',
  })
  numeroTicketGuia?: string;

  /**
   * Momento real de la venta, según el reloj del dispositivo. No es confiable: el
   * servidor lo acota al rango de vida del lote antes de usarlo.
   */
  @IsNotEmpty({ message: 'La fecha de emisión es obligatoria.' })
  @IsDateString(
    {},
    { message: 'La fecha de emisión debe ser una fecha válida (ISO 8601).' },
  )
  fechaEmision: string;

  /**
   * Dinero que realmente entró al cajón. Viaja como texto para no perder centavos
   * en el punto flotante de JSON.
   */
  @IsNotEmpty({ message: 'El monto cobrado es obligatorio.' })
  @IsNumberString(
    {},
    { message: 'El monto cobrado debe ser un número en formato texto.' },
  )
  montoCobrado: string;

  /**
   * Firma del folio hecha por la taquilla. Solo en el modo por dispositivo, donde
   * no hay folio reservado que respalde el pase: la firma ES el respaldo.
   */
  @IsOptional()
  @IsString({ message: 'La firma debe ser una cadena de texto.' })
  @MaxLength(128, { message: 'La firma no puede exceder 128 caracteres.' })
  firma?: string;

  /** Firma del segundo folio, cuando la venta lleva guía sin carnet. */
  @IsOptional()
  @IsString({ message: 'La firma del guía debe ser una cadena de texto.' })
  @MaxLength(128, {
    message: 'La firma del guía no puede exceder 128 caracteres.',
  })
  firmaGuia?: string;
}

/**
 * Subida de la cola sin conexión. Admite dos modos y exactamente uno por llamada:
 *
 *  - **Por dispositivo** (`dispositivo` + `idAperturaCaja`): la taquilla firmó sus
 *    propios pases con su llave. No hace falta reservar nada por adelantado.
 *  - **Por lote** (`idLote`): el modo anterior, con folios pre-firmados por el
 *    servidor. Se conserva para que las colas ya emitidas se puedan subir después
 *    de desplegar; sin eso, el despliegue dejaría dinero cobrado sin forma de entrar.
 */
export class EmitirOfflineDto {
  @IsOptional()
  @IsInt({ message: 'El ID del lote debe ser un número entero.' })
  @IsPositive({ message: 'El ID del lote debe ser positivo.' })
  idLote?: number;

  /** Taquilla que firmó estos pases. Excluyente con `idLote`. */
  @IsOptional()
  @IsString({
    message: 'El identificador del dispositivo debe ser una cadena de texto.',
  })
  @MaxLength(64, {
    message: 'El identificador no puede exceder 64 caracteres.',
  })
  dispositivo?: string;

  /**
   * Caja a la que entra esta recaudación. La trae el dispositivo porque la cacheó
   * cuando tuvo conexión; el servidor comprueba que siga abierta antes de aceptar
   * nada, para que no entre dinero a un arqueo ya congelado.
   */
  @IsOptional()
  @IsInt({ message: 'El ID de la apertura de caja debe ser un número entero.' })
  @IsPositive({ message: 'El ID de la apertura de caja debe ser positivo.' })
  idAperturaCaja?: number;

  @IsArray({ message: 'Las recaudaciones deben enviarse como un arreglo.' })
  @ArrayMinSize(1, { message: 'Debe enviar al menos una recaudación.' })
  @ArrayMaxSize(50, {
    message: 'No se pueden subir más de 50 recaudaciones por llamada.',
  })
  @ValidateNested({ each: true })
  @Type(() => VentaOfflineDto)
  ventas: VentaOfflineDto[];
}
