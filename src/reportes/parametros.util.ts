import { DefinicionReporte } from './contratos';
import { GenerarReporteDto } from './dto/generar-reporte.dto';

/**
 * Qué filtros acepta de verdad cada reporte.
 *
 * El catálogo ya publica los `parametros` de cada filtro, pero nadie los hacía
 * cumplir: mandarle `sector` a `ventas-resumen` devolvía 200 y el reporte hasta
 * imprimía «Sector: X» en su cabecera **sin haber filtrado nada**, porque su
 * consulta no mira ese campo. Un reporte que dice haber filtrado por algo que
 * ignoró no es un error cosmético: es una cifra que alguien va a archivar.
 *
 * Con un filtro que solo unas consultas pueden expresar —el día de la semana,
 * que exige truncar la fecha en SQL— dejarlo sin vigilar sería garantizar ese
 * error. Por eso lo que no está declarado se rechaza.
 */

/** Nombres de query string que el reporte declara en su catálogo. */
export function parametrosDeclarados(definicion: DefinicionReporte): Set<string> {
  const declarados = new Set<string>();
  for (const filtro of definicion.filtros) {
    const nombres =
      filtro.tipo === 'rangoFechas' ? ['desde', 'hasta'] : [filtro.clave];
    for (const nombre of nombres) declarados.add(nombre);
  }
  return declarados;
}

/** Los que llegaron con valor y el reporte no declara. Vacío = todo en orden. */
export function parametrosNoDeclarados(
  definicion: DefinicionReporte,
  dto: GenerarReporteDto,
): string[] {
  const declarados = parametrosDeclarados(definicion);
  return Object.entries(dto)
    .filter(([nombre, valor]) => {
      if (valor === undefined || valor === null || valor === '') return false;
      return !declarados.has(nombre);
    })
    .map(([nombre]) => nombre);
}
