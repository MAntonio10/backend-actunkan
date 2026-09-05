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
  @IsNotEmpty({ message: 'El idLocal es obligatorio: sin él no se puede reintentar sin duplicar.' })
  @IsString({ message: 'El idLocal debe ser una cadena de texto.' })
  @MaxLength(36, { message: 'El idLocal no puede exceder 36 caracteres.' })
  idLocal: string;

  /** Folio reservado que el dispositivo ya imprimió en el pase del visitante. */
  @IsNotEmpty({ message: 'El número de ticket es obligatorio.' })
  @IsString({ message: 'El número de ticket debe ser una cadena de texto.' })
  @MaxLength(30, { message: 'El número de ticket no puede exceder 30 caracteres.' })
  numeroTicket: string;

  /** Segundo folio, solo cuando la venta lleva guía sin carnet. */
  @IsOptional()
  @IsString({ message: 'El número de ticket del guía debe ser una cadena de texto.' })
  @MaxLength(30, { message: 'El número de ticket del guía no puede exceder 30 caracteres.' })
  numeroTicketGuia?: string;

  /**
   * Momento real de la venta, según el reloj del dispositivo. No es confiable: el
   * servidor lo acota al rango de vida del lote antes de usarlo.
   */
  @IsNotEmpty({ message: 'La fecha de emisión es obligatoria.' })
  @IsDateString({}, { message: 'La fecha de emisión debe ser una fecha válida (ISO 8601).' })
  fechaEmision: string;

  /**
   * Dinero que realmente entró al cajón. Viaja como texto para no perder centavos
   * en el punto flotante de JSON.
   */
  @IsNotEmpty({ message: 'El monto cobrado es obligatorio.' })
  @IsNumberString({}, { message: 'El monto cobrado debe ser un número en formato texto.' })
  montoCobrado: string;
}

export class EmitirOfflineDto {
  @IsNotEmpty({ message: 'El lote es obligatorio.' })
  @IsInt({ message: 'El ID del lote debe ser un número entero.' })
  @IsPositive({ message: 'El ID del lote debe ser positivo.' })
  idLote: number;

  @IsArray({ message: 'Las ventas deben enviarse como un arreglo.' })
  @ArrayMinSize(1, { message: 'Debe enviar al menos una venta.' })
  @ArrayMaxSize(50, { message: 'No se pueden subir más de 50 ventas por llamada.' })
  @ValidateNested({ each: true })
  @Type(() => VentaOfflineDto)
  ventas: VentaOfflineDto[];
}
