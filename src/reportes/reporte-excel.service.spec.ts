import * as ExcelJS from 'exceljs';
import { ResultadoReporte } from './contratos';
import { ReporteExcelService } from './reporte-excel.service';

/** Texto de una celda, sin caer en la representación por defecto de un objeto. */
function textoDe(celda: ExcelJS.Cell): string {
  const valor = celda.value;
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'object' && 'richText' in valor) {
    return valor.richText.map((t) => t.text).join('');
  }
  return typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
}

/**
 * Fila del encabezado de la tabla, buscada por el título de su primera columna.
 *
 * Antes iba fijada a mano y cualquier bloque nuevo en la cabecera —los indicadores,
 * sin ir más lejos— rompía media docena de pruebas que no tenían nada que ver.
 */
function filaEncabezado(hoja: ExcelJS.Worksheet, primerTitulo: string): number {
  for (let fila = 1; fila <= hoja.rowCount; fila += 1) {
    if (textoDe(hoja.getCell(fila, 1)) === primerTitulo) return fila;
  }
  throw new Error(`No se encontró el encabezado '${primerTitulo}'.`);
}

/** Vuelve a abrir el libro generado: es la única forma de comprobar tipos y formatos. */
async function abrir(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer as any);
  return libro;
}

const COLUMNAS: ResultadoReporte['secciones'][number]['columnas'] = [
  { clave: 'vendedor', titulo: 'Vendedor', formato: 'texto', ancho: 0.3 },
  { clave: 'tickets', titulo: 'Tickets', formato: 'entero', total: 'suma' },
  { clave: 'total', titulo: 'Total', formato: 'moneda', total: 'suma' },
  { clave: 'participacion', titulo: '% del total', formato: 'porcentaje' },
];

function reporteBase(
  parcial: Partial<ResultadoReporte> = {},
): ResultadoReporte {
  return {
    clave: 'ventas-por-vendedor',
    titulo: 'Ventas por vendedor',
    periodo: {
      desde: '2026-08-01',
      hasta: '2026-08-31',
      etiqueta: '1 al 31 de agosto de 2026',
    },
    filtrosAplicados: [{ etiqueta: 'Atracción', valor: 'Cuevas Actun Kan' }],
    kpis: [{ etiqueta: 'Recaudado', valor: 'Q1,170.00' }],
    secciones: [
      {
        titulo: 'Por vendedor',
        columnas: COLUMNAS,
        filas: [
          {
            vendedor: 'Ana Cajera',
            tickets: 12,
            total: '450.0000',
            participacion: '0.384615',
          },
          {
            vendedor: 'Luis Taquilla',
            tickets: 18,
            total: '720.0000',
            participacion: '0.615385',
          },
        ],
        totales: { tickets: '30', total: '1170.0000' },
      },
    ],
    orientacion: 'vertical',
    generadoEn: '2026-09-05T10:30:00.000Z',
    generadoPor: 'Ana Cajera',
    truncado: false,
    ...parcial,
  };
}

describe('ReporteExcelService', () => {
  const servicio = new ReporteExcelService();

  it('produce un libro que exceljs puede volver a abrir', async () => {
    const libro = await abrir(await servicio.generar(reporteBase()));

    // Con una sola sección no se emite portada: su contenido ya está entero en la
    // hoja de datos, y como primera pestaña solo lograba que el archivo abriera en
    // una vista sin la tabla.
    expect(libro.worksheets.map((h) => h.name)).toEqual(['Por vendedor']);
  });

  it('con varias secciones sí antepone la portada, y abre en los datos', async () => {
    const seccion = (titulo: string) => ({
      titulo,
      columnas: [{ clave: 'a', titulo: 'A', formato: 'texto' as const }],
      filas: [{ a: 'x' }],
    });

    const libro = await abrir(
      await servicio.generar(
        reporteBase({ secciones: [seccion('Uno'), seccion('Dos')] }),
      ),
    );

    expect(libro.worksheets.map((h) => h.name)).toEqual([
      'Resumen',
      'Uno',
      'Dos',
    ]);
    expect(libro.views[0]).toMatchObject({ activeTab: 1 });
  });

  it('cada hoja de datos lleva los indicadores, no solo la portada', async () => {
    const libro = await abrir(await servicio.generar(reporteBase()));
    const hoja = libro.getWorksheet('Por vendedor')!;

    const encabezado = filaEncabezado(hoja, 'Vendedor');
    let texto = '';
    for (let fila = 1; fila < encabezado; fila += 1) {
      texto += textoDe(hoja.getCell(fila, 1));
    }

    expect(texto).toContain('Recaudado');
    expect(texto).toContain('Q1,170.00');
  });

  it('las notas también van en la hoja de datos', async () => {
    const libro = await abrir(
      await servicio.generar(reporteBase({ notas: ['Nota de prueba.'] })),
    );
    const hoja = libro.getWorksheet('Por vendedor')!;

    let texto = '';
    for (let fila = 1; fila <= hoja.rowCount; fila += 1) {
      texto += textoDe(hoja.getCell(fila, 1));
    }

    expect(texto).toContain('Nota de prueba.');
  });

  describe('los números tienen que ser números', () => {
    /**
     * La aserción que justifica todo el archivo.
     *
     * Si el dinero se escribe como la cadena "Q450.00", el Excel deja de servir para lo
     * único que justifica pedirlo: seleccionar la columna y ver la suma, filtrar, o armar
     * una tabla dinámica. La presentación la pone `numFmt`, no el valor.
     */
    it('escribe la moneda como número con su formato, no como texto', async () => {
      const libro = await abrir(await servicio.generar(reporteBase()));
      const hoja = libro.getWorksheet('Por vendedor')!;

      const celda = hoja
        .findRow(filaEncabezado(hoja, 'Vendedor') + 1)!
        .getCell(3);

      expect(typeof celda.value).toBe('number');
      expect(celda.value).toBe(450);
      expect(celda.numFmt).toBe('"Q"#,##0.00');
    });

    it('escribe los enteros como números', async () => {
      const libro = await abrir(await servicio.generar(reporteBase()));
      const hoja = libro.getWorksheet('Por vendedor')!;
      const celda = hoja
        .findRow(filaEncabezado(hoja, 'Vendedor') + 1)!
        .getCell(2);

      expect(typeof celda.value).toBe('number');
      expect(celda.value).toBe(12);
      expect(celda.numFmt).toBe('#,##0');
    });

    it('escribe el porcentaje como fracción con formato de porcentaje', async () => {
      const libro = await abrir(await servicio.generar(reporteBase()));
      const hoja = libro.getWorksheet('Por vendedor')!;
      const celda = hoja
        .findRow(filaEncabezado(hoja, 'Vendedor') + 1)!
        .getCell(4);

      expect(celda.value).toBeCloseTo(0.384615, 5);
      expect(celda.numFmt).toBe('0.0%');
    });

    it('deja como texto una fecha que no se puede interpretar', async () => {
      const libro = await abrir(
        await servicio.generar(
          reporteBase({
            secciones: [
              {
                titulo: 'Actividades',
                columnas: [
                  { clave: 'fin', titulo: 'Fin', formato: 'fechaHora' },
                ],
                filas: [{ fin: 'Sin vencimiento' }],
              },
            ],
          }),
        ),
      );

      const hojaActividades = libro.getWorksheet('Actividades')!;
      const celda = hojaActividades
        .findRow(filaEncabezado(hojaActividades, 'Fin') + 1)!
        .getCell(1);
      expect(celda.value).toBe('Sin vencimiento');
    });
  });

  describe('fila de totales', () => {
    it('usa SUBTOTAL para que se recalcule al filtrar, con el valor como respaldo', async () => {
      const libro = await abrir(await servicio.generar(reporteBase()));
      const hoja = libro.getWorksheet('Por vendedor')!;
      const encabezado = filaEncabezado(hoja, 'Vendedor');
      const celda = hoja.findRow(encabezado + 3)!.getCell(3);
      const valor = celda.value as ExcelJS.CellFormulaValue;

      expect(valor.formula).toBe(
        `SUBTOTAL(109,C${encabezado + 1}:C${encabezado + 2})`,
      );
      expect(valor.result).toBe(1170);
    });

    it('rotula la primera columna del total', async () => {
      const libro = await abrir(await servicio.generar(reporteBase()));
      const hoja = libro.getWorksheet('Por vendedor')!;
      expect(
        hoja.findRow(filaEncabezado(hoja, 'Vendedor') + 3)!.getCell(1).value,
      ).toBe('TOTAL');
    });
  });

  it('congela el encabezado y activa el autofiltro', async () => {
    const libro = await abrir(await servicio.generar(reporteBase()));
    const hoja = libro.getWorksheet('Por vendedor')!;

    expect(hoja.views[0]).toMatchObject({
      state: 'frozen',
      ySplit: filaEncabezado(hoja, 'Vendedor'),
    });
    expect(hoja.autoFilter).toBeTruthy();
  });

  it('repite el período y los filtros en cada hoja de datos', async () => {
    const libro = await abrir(await servicio.generar(reporteBase()));
    const hoja = libro.getWorksheet('Por vendedor')!;

    // 1 título, 2 título de la sección, 3 período, 4 filtros.
    expect(textoDe(hoja.getCell(1, 1))).toContain('Ventas por vendedor');
    expect(textoDe(hoja.getCell(2, 1))).toContain('Por vendedor');
    expect(textoDe(hoja.getCell(3, 1))).toContain('1 al 31 de agosto de 2026');
    expect(textoDe(hoja.getCell(4, 1))).toContain('Cuevas Actun Kan');
  });

  describe('nombres de hoja', () => {
    /** Excel rechaza más de 31 caracteres y ciertos símbolos, y no admite duplicados. */
    it('desambigua dos títulos largos que colisionan al recortarse', async () => {
      const seccion = (titulo: string) => ({
        titulo,
        columnas: [{ clave: 'a', titulo: 'A', formato: 'texto' as const }],
        filas: [{ a: 'x' }],
      });

      const libro = await abrir(
        await servicio.generar(
          reporteBase({
            secciones: [
              seccion('Desglose por categoría de visitante nacional'),
              seccion('Desglose por categoría de visitante extranjero'),
            ],
          }),
        ),
      );

      const nombres = libro.worksheets.map((h) => h.name);
      expect(new Set(nombres).size).toBe(nombres.length);
      expect(nombres.every((n) => n.length <= 31)).toBe(true);
    });

    it('quita los caracteres que Excel no admite en el nombre', async () => {
      const libro = await abrir(
        await servicio.generar(
          reporteBase({
            secciones: [
              {
                titulo: 'Ventas / caja [2026]',
                columnas: [{ clave: 'a', titulo: 'A', formato: 'texto' }],
                filas: [{ a: 'x' }],
              },
            ],
          }),
        ),
      );

      expect(libro.worksheets[0].name).not.toMatch(/[[\]:*?/\\]/);
    });
  });

  it('la portada de un reporte de varias secciones lleva KPIs, notas y autoría', async () => {
    const seccion = (titulo: string) => ({
      titulo,
      columnas: [{ clave: 'a', titulo: 'A', formato: 'texto' as const }],
      filas: [{ a: 'x' }],
    });

    const libro = await abrir(
      await servicio.generar(
        reporteBase({
          notas: ['Los anulados no suman al recaudado.'],
          secciones: [seccion('Uno'), seccion('Dos')],
        }),
      ),
    );
    const resumen = libro.getWorksheet('Resumen')!;
    const contenido = JSON.stringify(resumen.getSheetValues());

    expect(contenido).toContain('Recaudado');
    expect(contenido).toContain('Q1,170.00');
    expect(contenido).toContain('anulados no suman');
    expect(contenido).toContain('Ana Cajera');
  });

  it('genera igual un reporte sin ninguna fila', async () => {
    const libro = await abrir(
      await servicio.generar(
        reporteBase({
          secciones: [{ titulo: 'Vacía', columnas: COLUMNAS, filas: [] }],
        }),
      ),
    );

    expect(libro.getWorksheet('Vacía')).toBeDefined();
  });
});
