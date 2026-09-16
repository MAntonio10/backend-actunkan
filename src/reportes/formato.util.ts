import { Prisma } from '@prisma/client';
import { AlineacionColumna, ColumnaReporte, ValorCelda } from './contratos';

/**
 * Normalización de tipos y formateo de celdas.
 *
 * Los tipos que devuelve el driver de SQL Server no coinciden con los del schema, y
 * `$queryRaw` devuelve cosas distintas de las que devuelve `aggregate()`. Además el
 * proyecto tiene `@prisma/adapter-mssql` instalado pero `PrismaService` todavía no lo
 * usa; si mañana se cablea, el mapeo de `DECIMAL` vuelve a cambiar. Por eso la
 * normalización es defensiva y obligatoria, no un extra.
 */

type CrudoNumerico =
  Prisma.Decimal | bigint | number | string | null | undefined;

/**
 * `DECIMAL`/`NUMERIC` llegan como `Prisma.Decimal` desde el motor Rust, y pueden llegar
 * como `number` o `string` desde un adaptador de driver. El string preserva la precisión;
 * el number puede haberla perdido antes de llegar aquí, pero es lo único disponible —
 * por eso el SQL del módulo evita devolver `FLOAT`.
 */
export function aDecimal(valor: CrudoNumerico): Prisma.Decimal {
  if (valor === null || valor === undefined) return new Prisma.Decimal(0);
  if (valor instanceof Prisma.Decimal) return valor;
  if (typeof valor === 'bigint') return new Prisma.Decimal(valor.toString());
  return new Prisma.Decimal(valor);
}

/**
 * `COUNT(*)` es `INT` en SQL Server y llega como `number`; `COUNT_BIG` y las columnas
 * `BIGINT` llegan como `bigint`, que revienta `JSON.stringify` con
 * "Do not know how to serialize a BigInt" y NestJS convierte en un 500 sin pista.
 * Por eso el SQL del módulo usa `COUNT(*)` y todo pasa igualmente por aquí.
 */
export function aEntero(valor: CrudoNumerico): number {
  if (valor === null || valor === undefined) return 0;
  if (typeof valor === 'bigint') return Number(valor);
  if (valor instanceof Prisma.Decimal) return valor.toNumber();
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

/** Cadena decimal exacta lista para una celda. Nunca pasa por `number`. */
export function aTextoDecimal(valor: CrudoNumerico, decimales = 2): string {
  return aDecimal(valor).toFixed(decimales);
}

/**
 * Porcentaje que una parte representa del total, como fracción (0-1).
 * Se guarda como fracción y no como 0-100 porque es lo que espera el formato
 * `0.0%` de Excel; el PDF multiplica al imprimir.
 */
export function porcentajeDe(
  parte: CrudoNumerico,
  total: CrudoNumerico,
): string {
  const divisor = aDecimal(total);
  if (divisor.isZero()) return '0';
  return aDecimal(parte).div(divisor).toFixed(6);
}

/** Suma una columna de filas ya normalizadas, con Decimal. */
export function sumarColumna(
  filas: Array<Record<string, ValorCelda>>,
  clave: string,
): Prisma.Decimal {
  return filas.reduce(
    (acumulado, fila) => acumulado.plus(aDecimal(fila[clave] as CrudoNumerico)),
    new Prisma.Decimal(0),
  );
}

// ---------------------------------------------------------------------------
// Formateo para presentación
// ---------------------------------------------------------------------------

/** Separador de miles sobre la representación textual, sin pasar por float. */
export function separarMiles(texto: string): string {
  const negativo = texto.startsWith('-');
  const limpio = negativo ? texto.slice(1) : texto;
  const [entera, decimal] = limpio.split('.');
  const conMiles = entera.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negativo ? '-' : ''}${conMiles}${decimal ? `.${decimal}` : ''}`;
}

export function alineacionDe(columna: ColumnaReporte): AlineacionColumna {
  if (columna.alineacion) return columna.alineacion;
  return columna.formato === 'texto' ||
    columna.formato === 'fecha' ||
    columna.formato === 'fechaHora'
    ? 'izquierda'
    : 'derecha';
}

export function esColumnaNumerica(columna: ColumnaReporte): boolean {
  return (
    columna.formato === 'entero' ||
    columna.formato === 'decimal' ||
    columna.formato === 'moneda' ||
    columna.formato === 'porcentaje'
  );
}

/** Vacío visible: una celda en blanco se confunde con un cero perdido. */
export const CELDA_VACIA = '—';

/**
 * Texto de una celda para el PDF. El Excel **no** usa esta función: allá los números
 * se escriben como números y el formato lo pone `numFmt`, que es lo único que permite
 * sumar y filtrar dentro de la hoja.
 */
export function formatearCelda(
  valor: ValorCelda,
  columna: ColumnaReporte,
): string {
  if (valor === null || valor === undefined || valor === '') return CELDA_VACIA;

  switch (columna.formato) {
    case 'moneda':
      return `Q${separarMiles(aTextoDecimal(valor as CrudoNumerico, columna.decimales ?? 2))}`;

    case 'decimal':
      return separarMiles(
        aTextoDecimal(valor as CrudoNumerico, columna.decimales ?? 2),
      );

    case 'entero':
      return separarMiles(aDecimal(valor as CrudoNumerico).toFixed(0));

    case 'porcentaje':
      // Se almacena como fracción; aquí se lleva a 0-100 para leerlo.
      return `${separarMiles(
        aDecimal(valor as CrudoNumerico)
          .times(100)
          .toFixed(columna.decimales ?? 1),
      )}%`;

    case 'fecha':
      return String(valor).slice(0, 10);

    case 'fechaHora':
      return String(valor).slice(0, 16).replace('T', ' ');

    default:
      return String(valor);
  }
}

/**
 * Prepara un valor del usuario para citarlo dentro de un mensaje de error.
 *
 * Decirle a alguien qué escribió ayuda a que corrija el filtro, pero devolver su texto
 * intacto convierte cada 404 y cada 422 en un reflejo: basta con que el frontend pinte
 * `message` con `innerHTML`, o que alguien abra la URL directamente en el navegador, para
 * que un `<script>` incrustado en un filtro se ejecute. Se quitan los caracteres con los
 * que se arma marcado y se recorta: el mensaje sigue siendo útil y deja de ser un vector.
 */
export function textoSeguroParaMensaje(valor: string, maximo = 60): string {
  const limpio = String(valor ?? '')
    // Neutralizar los caracteres de control es justo el objetivo: un salto de linea
    // en el valor permitiria falsificar una linea del registro del servidor.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // Sin `<`, `>` ni comillas el valor ya no puede formar una etiqueta ni salirse de un
    // atributo: esta linea es la defensa real.
    .replace(/[<>"'`]/g, '')
    // Y esta es defensa en profundidad, por si el frontend llega a interpolar el mensaje
    // dentro de un atributo ya abierto: lo que quede de un payload no debe ni parecer un
    // manejador de eventos ni un esquema ejecutable.
    .replace(/\bon\w+\s*=/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return limpio.length > maximo ? `${limpio.slice(0, maximo)}...` : limpio;
}

/** Nombre de archivo seguro para `Content-Disposition`. */
export function nombreArchivoSeguro(base: string): string {
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
