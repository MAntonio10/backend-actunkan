import { PrismaService } from '../../../prisma/prisma.service';
import { FiltrosResueltos, SeccionReporte } from '../../contratos';
import { ClaveDimension, DIMENSIONES } from '../../consultas/dimensiones';
import { agruparVentasPor } from '../../consultas/ventas.consulta';
import {
  COLUMNA_PARTICIPACION,
  COLUMNA_PERSONAS,
  COLUMNA_TICKETS,
  COLUMNA_TOTAL,
  conParticipacion,
  totalesDe,
} from '../comunes';

/**
 * Sección de desglose por dimensión, compartida por los reportes "ventas por ...".
 *
 * Los cuatro son entradas distintas del catálogo porque el frontend necesita botones con
 * nombre y la IA necesita descripciones distintas para acertar; pero por debajo hay una
 * sola consulta y una sola forma de armar la tabla, así que no pueden discrepar.
 */
export async function seccionPorDimension(
  prisma: PrismaService,
  dimension: ClaveDimension,
  filtros: FiltrosResueltos,
  titulo?: string,
): Promise<SeccionReporte> {
  const dim = DIMENSIONES[dimension];
  const columnas = [
    {
      clave: 'grupo',
      titulo: dim.etiquetaColumna,
      formato: 'texto' as const,
      ancho: 0.32,
    },
    COLUMNA_TICKETS,
    COLUMNA_PERSONAS,
    COLUMNA_TOTAL,
    COLUMNA_PARTICIPACION,
  ];

  const filas = conParticipacion(
    (await agruparVentasPor(prisma, dimension, filtros)) as unknown as Array<
      Record<string, string | number | boolean | null>
    >,
  );

  return {
    titulo,
    columnas,
    filas,
    totales: totalesDe(columnas, filas),
  };
}
