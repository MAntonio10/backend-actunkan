/**
 * Folios correlativos por serie y año.
 *
 * El contador es numérico, pero el folio que se persiste es **siempre texto**:
 * la serie es alfanumérica y configurable (`TCK` para tickets, `DON` para recibos
 * de donación), así que el orden alfabético de un folio no equivale al cronológico.
 * Para ordenar listados hay que usar la fecha o el id, nunca el folio.
 *
 * Debe llamarse dentro de una transacción con aislamiento `Serializable`: sin él,
 * dos emisiones concurrentes pueden leer el mismo último número.
 */
export async function generarCorrelativo(
  tx: any,
  serie: string,
  anio: number,
  digitos = 6,
): Promise<string> {
  const serieNormalizada = serie.toUpperCase();

  const correlativo = await tx.correlativo.upsert({
    where: { serie_anio: { serie: serieNormalizada, anio } },
    create: { serie: serieNormalizada, anio, ultimoNumero: 1 },
    update: { ultimoNumero: { increment: 1 } },
  });

  return `${serieNormalizada}-${anio}-${String(correlativo.ultimoNumero).padStart(digitos, '0')}`;
}
