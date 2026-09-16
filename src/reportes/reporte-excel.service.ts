import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  ColumnaReporte,
  ResultadoReporte,
  SeccionReporte,
  ValorCelda,
} from './contratos';
import { alineacionDe, esColumnaNumerica } from './formato.util';

/**
 * Formatos de número por tipo de columna.
 *
 * Lo que hace útil un Excel es que los números **sean** números. Si se escriben como texto
 * ya formateado, el archivo no sirve para lo único que justifica pedirlo: seleccionar una
 * columna y ver la suma, filtrar, o armar una tabla dinámica. Por eso el tipo de celda lo
 * decide el formato de la columna y la presentación la pone `numFmt`.
 */
const FORMATO_NUMERO: Record<string, string> = {
  moneda: '"Q"#,##0.00',
  entero: '#,##0',
  decimal: '#,##0.00',
  porcentaje: '0.0%',
  fecha: 'yyyy-mm-dd',
  fechaHora: 'yyyy-mm-dd hh:mm',
};

const ALINEACION_EXCEL: Record<string, 'left' | 'center' | 'right'> = {
  izquierda: 'left',
  centro: 'center',
  derecha: 'right',
};

const RELLENO_ENCABEZADO: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFEDEDE8' },
};

const ANCHO_MAXIMO_COLUMNA = 60;
const ANCHO_MINIMO_COLUMNA = 10;
/** Excel no admite más de 31 caracteres en el nombre de una hoja. */
const MAXIMO_NOMBRE_HOJA = 31;

@Injectable()
export class ReporteExcelService {
  /**
   * Nombre de hoja válido y único.
   *
   * Excel rechaza `[ ] : * ? / \` y trunca a 31 caracteres. Dos secciones con títulos
   * largos y parecidos colisionarían al recortarse, y `addWorksheet` lanzaría; por eso se
   * desambigua con un sufijo.
   */
  private nombreDeHoja(
    titulo: string,
    usados: Set<string>,
    respaldo: string,
  ): string {
    const limpio =
      (titulo || respaldo).replace(/[[\]:*?/\\]/g, ' ').trim() || respaldo;
    let nombre = limpio.slice(0, MAXIMO_NOMBRE_HOJA);

    let sufijo = 2;
    while (usados.has(nombre.toLocaleLowerCase('es'))) {
      const cola = ` (${sufijo})`;
      nombre = `${limpio.slice(0, MAXIMO_NOMBRE_HOJA - cola.length)}${cola}`;
      sufijo += 1;
    }

    usados.add(nombre.toLocaleLowerCase('es'));
    return nombre;
  }

  /**
   * Convierte el valor de la celda al tipo que le toca en Excel.
   *
   * El dinero viaja como cadena decimal exacta y aquí se convierte a `number`. No es una
   * pérdida evitable: una celda numérica de Excel *es* un flotante de doble precisión, así
   * que la exactitud se pierde en el formato, no en el código. El PDF, que es el documento
   * auditable, conserva la cadena.
   */
  private valorDeCelda(
    valor: ValorCelda,
    columna: ColumnaReporte,
  ): ExcelJS.CellValue {
    if (valor === null || valor === undefined || valor === '') return null;

    if (esColumnaNumerica(columna)) {
      const numero = Number(valor);
      return Number.isFinite(numero) ? numero : String(valor);
    }

    if (columna.formato === 'fecha' || columna.formato === 'fechaHora') {
      const texto = String(valor);
      const fecha = new Date(
        texto.includes('T') ? texto : texto.replace(' ', 'T'),
      );
      // Un valor no parseable (por ejemplo "Sin vencimiento") se deja como texto en vez
      // de escribir una fecha inválida que Excel muestra como ####.
      return Number.isNaN(fecha.getTime()) ? texto : fecha;
    }

    return String(valor);
  }

  private aplicarFormato(celda: ExcelJS.Cell, columna: ColumnaReporte) {
    const formato = FORMATO_NUMERO[columna.formato];
    if (formato) {
      celda.numFmt =
        columna.formato === 'decimal' && columna.decimales === 0
          ? '#,##0'
          : formato;
    }
    celda.alignment = {
      horizontal: ALINEACION_EXCEL[alineacionDe(columna)],
      vertical: 'middle',
    };
  }

  /** Ancho en caracteres, con la misma idea de muestreo que el PDF. */
  private anchoDeColumna(
    columna: ColumnaReporte,
    seccion: SeccionReporte,
  ): number {
    const muestra =
      seccion.filas.length > 200 ? seccion.filas.slice(0, 200) : seccion.filas;
    let maximo = columna.titulo.length;

    for (const fila of muestra) {
      const valor = fila[columna.clave];
      if (valor === null || valor === undefined) continue;
      const largo = String(valor).length;
      if (largo > maximo) maximo = largo;
    }

    // El tope evita que una descripción de bitácora, que es NVARCHAR(Max), genere una
    // columna imposible de leer.
    return Math.min(
      Math.max(maximo + 2, ANCHO_MINIMO_COLUMNA),
      ANCHO_MAXIMO_COLUMNA,
    );
  }

  /** Bloque de identificación que encabeza cada hoja. */
  private escribirEncabezado(
    hoja: ExcelJS.Worksheet,
    reporte: ResultadoReporte,
    subtitulo?: string,
  ): number {
    let fila = 1;

    hoja.getCell(fila, 1).value = reporte.titulo;
    hoja.getCell(fila, 1).font = { bold: true, size: 14 };
    fila += 1;

    if (subtitulo || reporte.subtitulo) {
      hoja.getCell(fila, 1).value = subtitulo ?? reporte.subtitulo!;
      hoja.getCell(fila, 1).font = { size: 10, color: { argb: 'FF7A7A75' } };
      fila += 1;
    }

    if (reporte.periodo) {
      hoja.getCell(fila, 1).value = `Período: ${reporte.periodo.etiqueta}`;
      hoja.getCell(fila, 1).font = {
        bold: true,
        size: 10,
        color: { argb: 'FF1F5A7A' },
      };
      fila += 1;
    }

    // Los filtros van también aquí, y no solo en la hoja de resumen: una hoja copiada a
    // otro archivo tiene que seguir diciendo de qué período y con qué filtros se sacó.
    const linea = reporte.filtrosAplicados.length
      ? reporte.filtrosAplicados
          .map((f) => `${f.etiqueta}: ${f.valor}`)
          .join('  ·  ')
      : 'Sin filtros adicionales';
    hoja.getCell(fila, 1).value = linea;
    hoja.getCell(fila, 1).font = { size: 9, color: { argb: 'FF7A7A75' } };
    fila += 2;

    return fila;
  }

  private escribirTabla(
    hoja: ExcelJS.Worksheet,
    seccion: SeccionReporte,
    filaInicial: number,
  ) {
    const filaEncabezado = filaInicial;

    seccion.columnas.forEach((columna, indice) => {
      const celda = hoja.getCell(filaEncabezado, indice + 1);
      celda.value = columna.titulo;
      celda.font = { bold: true, size: 10 };
      celda.fill = RELLENO_ENCABEZADO;
      celda.border = { bottom: { style: 'thin', color: { argb: 'FFC9C9C4' } } };
      celda.alignment = {
        horizontal: ALINEACION_EXCEL[alineacionDe(columna)],
        vertical: 'middle',
      };
      hoja.getColumn(indice + 1).width = this.anchoDeColumna(columna, seccion);
    });

    seccion.filas.forEach((fila, indiceFila) => {
      seccion.columnas.forEach((columna, indiceColumna) => {
        const celda = hoja.getCell(
          filaEncabezado + 1 + indiceFila,
          indiceColumna + 1,
        );
        celda.value = this.valorDeCelda(fila[columna.clave] ?? null, columna);
        this.aplicarFormato(celda, columna);
      });
    });

    const primeraFilaDatos = filaEncabezado + 1;
    const ultimaFilaDatos = filaEncabezado + seccion.filas.length;

    // Autofiltro y encabezados congelados: sin ellos, bajar por cuarenta mil filas de
    // bitácora deja de tener sentido porque se pierden los títulos.
    if (seccion.filas.length > 0) {
      hoja.autoFilter = {
        from: { row: filaEncabezado, column: 1 },
        to: { row: ultimaFilaDatos, column: seccion.columnas.length },
      };
      hoja.views = [{ state: 'frozen', ySplit: filaEncabezado }];
    }

    if (!seccion.totales) return ultimaFilaDatos + 2;

    const filaTotales = ultimaFilaDatos + 1;

    seccion.columnas.forEach((columna, indice) => {
      const celda = hoja.getCell(filaTotales, indice + 1);
      const valor = seccion.totales![columna.clave];
      const vacio = valor === undefined || valor === null || valor === '';

      if (indice === 0 && vacio) {
        celda.value = 'TOTAL';
      } else if (!vacio) {
        if (esColumnaNumerica(columna) && seccion.filas.length > 0) {
          const letra = hoja.getColumn(indice + 1).letter;
          // SUBTOTAL(109) suma ignorando las filas ocultas, así que el total se recalcula
          // solo cuando el usuario filtra dentro de la hoja — que es justo para lo que va
          // a usar el Excel. El `result` deja la cifra visible en los visores que no
          // evalúan fórmulas.
          celda.value = {
            formula: `SUBTOTAL(109,${letra}${primeraFilaDatos}:${letra}${ultimaFilaDatos})`,
            result: Number(valor),
          };
        } else {
          celda.value = this.valorDeCelda(valor, columna);
        }
      }

      celda.font = { bold: true, size: 10 };
      celda.border = { top: { style: 'thin', color: { argb: 'FF1C1C1A' } } };
      this.aplicarFormato(celda, columna);
    });

    return filaTotales + 2;
  }

  /** Hoja de portada con los KPIs, el período y las notas. */
  private escribirResumen(
    libro: ExcelJS.Workbook,
    reporte: ResultadoReporte,
    usados: Set<string>,
  ) {
    const hoja = libro.addWorksheet(
      this.nombreDeHoja('Resumen', usados, 'Resumen'),
    );
    hoja.getColumn(1).width = 34;
    hoja.getColumn(2).width = 26;

    let fila = this.escribirEncabezado(hoja, reporte);

    if (reporte.kpis.length > 0) {
      hoja.getCell(fila, 1).value = 'Indicadores';
      hoja.getCell(fila, 1).font = { bold: true, size: 11 };
      fila += 1;

      for (const kpi of reporte.kpis) {
        hoja.getCell(fila, 1).value = kpi.etiqueta;
        hoja.getCell(fila, 2).value = kpi.valor;
        hoja.getCell(fila, 2).font = { bold: true };
        if (kpi.detalle) {
          hoja.getCell(fila, 3).value = kpi.detalle;
          hoja.getCell(fila, 3).font = { size: 9, color: { argb: 'FF7A7A75' } };
        }
        fila += 1;
      }
      fila += 1;
    }

    if (reporte.notas?.length) {
      hoja.getCell(fila, 1).value = 'Notas';
      hoja.getCell(fila, 1).font = { bold: true, size: 11 };
      fila += 1;

      for (const nota of reporte.notas) {
        const celda = hoja.getCell(fila, 1);
        celda.value = nota;
        celda.font = { size: 9, color: { argb: 'FF7A7A75' } };
        celda.alignment = { wrapText: true, vertical: 'top' };
        hoja.mergeCells(fila, 1, fila, 4);
        fila += 1;
      }
      fila += 1;
    }

    hoja.getCell(fila, 1).value = `Generado por ${reporte.generadoPor}`;
    hoja.getCell(fila, 1).font = { size: 9, color: { argb: 'FF7A7A75' } };
    hoja.getCell(fila + 1, 1).value = reporte.generadoEn
      .slice(0, 16)
      .replace('T', ' ');
    hoja.getCell(fila + 1, 1).font = { size: 9, color: { argb: 'FF7A7A75' } };
  }

  async generar(reporte: ResultadoReporte): Promise<Buffer> {
    const libro = new ExcelJS.Workbook();
    libro.creator = 'Actún Kan';
    libro.lastModifiedBy = reporte.generadoPor;
    libro.created = new Date(reporte.generadoEn);

    const usados = new Set<string>();
    this.escribirResumen(libro, reporte, usados);

    reporte.secciones.forEach((seccion, indice) => {
      const hoja = libro.addWorksheet(
        this.nombreDeHoja(
          seccion.titulo ?? reporte.titulo,
          usados,
          `Datos ${indice + 1}`,
        ),
      );
      const filaInicial = this.escribirEncabezado(
        hoja,
        reporte,
        seccion.titulo,
      );
      this.escribirTabla(hoja, seccion, filaInicial);
    });

    // `writeBuffer` devuelve un ArrayBuffer; el controlador necesita un Buffer de Node
    // para poder informar el Content-Length.
    const datos = await libro.xlsx.writeBuffer();
    return Buffer.from(datos);
  }
}
