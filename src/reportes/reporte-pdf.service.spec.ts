import { inflateSync } from 'zlib';
import { ResultadoReporte } from './contratos';
import { ReportePdfService } from './reporte-pdf.service';

/**
 * Extrae el texto visible de un PDF de pdfkit.
 *
 * No basta con buscar en el binario: pdfkit comprime los flujos de contenido y dentro
 * escribe el texto como cadenas hexadecimales (`<526573756d656e>`). Hay que descomprimir
 * y decodificar, y por eso este ayudante existe en vez de un `toString().includes()`.
 */
function textoDelPdf(pdf: Buffer): string {
  const crudo = pdf.toString('latin1');
  const flujos = /stream\r?\n([\s\S]*?)\r?\nendstream/g;

  let contenido = '';
  let coincidencia: RegExpExecArray | null;
  while ((coincidencia = flujos.exec(crudo)) !== null) {
    try {
      contenido += inflateSync(Buffer.from(coincidencia[1], 'latin1')).toString(
        'latin1',
      );
    } catch {
      // Los flujos de las imágenes no son inflables con zlib; se ignoran.
    }
  }

  // Se unen sin separador: pdfkit parte cada línea en varios trozos para aplicar el
  // kerning ("P" + "ágina"), y meter un espacio entre ellos rompería toda comparación.
  return (contenido.match(/<([0-9A-Fa-f]+)>/g) ?? [])
    .map((hex) => Buffer.from(hex.slice(1, -1), 'hex').toString('latin1'))
    .join('');
}

/** Cuenta las páginas por sus objetos `/Type /Page`. */
function contarPaginas(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

const COLUMNAS: ResultadoReporte['secciones'][number]['columnas'] = [
  { clave: 'dia', titulo: 'Dia', formato: 'fecha', ancho: 0.3 },
  { clave: 'tickets', titulo: 'Tickets', formato: 'entero', total: 'suma' },
  { clave: 'total', titulo: 'Total', formato: 'moneda', total: 'suma' },
];

function reporteBase(
  parcial: Partial<ResultadoReporte> = {},
): ResultadoReporte {
  return {
    clave: 'ventas-resumen',
    titulo: 'Resumen de ventas',
    periodo: {
      desde: '2026-08-01',
      hasta: '2026-08-31',
      etiqueta: '1 al 31 de agosto de 2026',
    },
    filtrosAplicados: [{ etiqueta: 'Vendedor', valor: 'Ana Cajera' }],
    kpis: [
      { etiqueta: 'Recaudado', valor: 'Q12,500.00' },
      { etiqueta: 'Tickets', valor: '340' },
    ],
    secciones: [
      {
        columnas: COLUMNAS,
        filas: [
          { dia: '2026-08-01', tickets: 12, total: '450.0000' },
          { dia: '2026-08-02', tickets: 18, total: '720.0000' },
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

describe('ReportePdfService', () => {
  const servicio = new ReportePdfService();

  it('produce un PDF válido', async () => {
    const pdf = await servicio.generar(reporteBase());

    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('imprime el título, el período, los filtros y quién lo generó', async () => {
    const texto = textoDelPdf(await servicio.generar(reporteBase()));

    expect(texto).toContain('Resumen de ventas');
    expect(texto).toContain('1 al 31 de agosto de 2026');
    expect(texto).toContain('Vendedor');
    expect(texto).toContain('Ana Cajera');
  });

  it('formatea el dinero con símbolo y separador de miles', async () => {
    const texto = textoDelPdf(await servicio.generar(reporteBase()));
    expect(texto).toContain('Q1,170.00');
  });

  it('reparte una tabla larga en varias páginas', async () => {
    const filas = Array.from({ length: 400 }, (_, i) => ({
      dia: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      tickets: i,
      total: `${i * 10}.0000`,
    }));

    const pdf = await servicio.generar(
      reporteBase({
        secciones: [
          {
            columnas: COLUMNAS,
            filas,
            totales: { tickets: '400', total: '798000.0000' },
          },
        ],
      }),
    );

    expect(contarPaginas(pdf)).toBeGreaterThan(1);
  });

  it('repite el encabezado de la tabla en cada página', async () => {
    const filas = Array.from({ length: 200 }, () => ({
      dia: '2026-08-01',
      tickets: 1,
      total: '10.0000',
    }));

    const pdf = await servicio.generar(
      reporteBase({ secciones: [{ columnas: COLUMNAS, filas }] }),
    );
    const texto = textoDelPdf(pdf);
    const paginas = contarPaginas(pdf);
    const veces = (texto.match(/Tickets/g) ?? []).length;

    // Una vez por página como encabezado, más la del KPI de la primera.
    expect(veces).toBeGreaterThanOrEqual(paginas);
  });

  /**
   * La regresión que este caso vigila: estampar el pie sin poner el margen inferior a
   * cero hace que pdfkit añada una página por cada página numerada, y el documento
   * termina con la mitad de las hojas en blanco.
   */
  it('numera las páginas sin añadir hojas en blanco', async () => {
    const filas = Array.from({ length: 200 }, () => ({
      dia: '2026-08-01',
      tickets: 1,
      total: '10.0000',
    }));

    const pdf = await servicio.generar(
      reporteBase({ secciones: [{ columnas: COLUMNAS, filas }] }),
    );
    const paginas = contarPaginas(pdf);
    const texto = textoDelPdf(pdf);

    expect(paginas).toBeGreaterThan(1);
    expect(texto).toContain(`Página 1 de ${paginas}`);
    // Si el pie hubiera duplicado las páginas, la última numerada no coincidiría con el
    // total real del documento.
    expect(texto).toContain(`Página ${paginas} de ${paginas}`);
  });

  it('sale en horizontal cuando el reporte lo pide', async () => {
    const vertical = await servicio.generar(
      reporteBase({ orientacion: 'vertical' }),
    );
    const horizontal = await servicio.generar(
      reporteBase({ orientacion: 'horizontal' }),
    );

    expect(vertical.toString('latin1')).toContain('MediaBox [0 0 612 792]');
    expect(horizontal.toString('latin1')).toContain('MediaBox [0 0 792 612]');
  });

  it('dibuja la tabla aunque no haya ni una fila', async () => {
    const pdf = await servicio.generar(
      reporteBase({
        secciones: [{ columnas: COLUMNAS, filas: [], totales: null }],
        kpis: [],
      }),
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(textoDelPdf(pdf)).toContain('Sin datos');
  });

  it('imprime las notas del reporte', async () => {
    const pdf = await servicio.generar(
      reporteBase({ notas: ['Los tickets anulados no suman al recaudado.'] }),
    );

    const texto = textoDelPdf(pdf);
    expect(texto).toContain('NOTAS');
    expect(texto).toContain('anulados no suman');
  });

  it('deja constancia de los filtros aunque no se haya aplicado ninguno', async () => {
    const texto = textoDelPdf(
      await servicio.generar(reporteBase({ filtrosAplicados: [] })),
    );
    expect(texto).toContain('Sin filtros adicionales');
  });
});
