import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import PDFDocument from 'pdfkit';
import {
  ColumnaReporte,
  ResultadoReporte,
  SeccionReporte,
  ValorCelda,
} from './contratos';
import { alineacionDe, formatearCelda } from './formato.util';

const MARGEN = { superior: 46, inferior: 46, izquierdo: 36, derecho: 36 };
const ALTO_ENCABEZADO_TABLA = 20;
const ALTO_FILA = 16;
const ALTO_TOTALES = 18;
const RELLENO = 5;
const ALTO_LOGO = 26;
const ALTO_KPI = 42;
const KPIS_POR_FILA = 4;

const COLOR = {
  texto: '#1C1C1A',
  gris: '#7A7A75',
  linea: '#C9C9C4',
  cebra: '#F4F4F1',
  encabezado: '#EDEDE8',
  acento: '#1F5A7A',
};

/** Alineación de pdfkit a partir de la nuestra. */
const ALINEACION_PDF: Record<string, 'left' | 'center' | 'right'> = {
  izquierda: 'left',
  centro: 'center',
  derecha: 'right',
};

/**
 * Renderizador genérico de reportes a PDF.
 *
 * No sabe qué es un ticket ni una caja: recibe un `ResultadoReporte` ya depurado y dibuja
 * lo que traiga. Por eso las 18 definiciones no tienen una línea de código de dibujo, y
 * agregar un reporte nuevo no toca este archivo.
 *
 * Sigue el mismo patrón que `TicketPdfService` y `DonacionPdfService`, con dos diferencias
 * que impone el formato: aquí las páginas son muchas y de tamaño carta, y se numeran.
 */
@Injectable()
export class ReportePdfService {
  private readonly logger = new Logger(ReportePdfService.name);
  private logosCache: { actun?: Buffer; propeten?: Buffer } | null = null;

  private cargarLogos() {
    if (this.logosCache) return this.logosCache;

    const posibles = [
      join(process.cwd(), 'logos', 'optimizados'),
      join(__dirname, '..', '..', '..', 'logos', 'optimizados'),
    ];
    const base = posibles.find((ruta) => existsSync(join(ruta, 'actun.png')));

    if (!base) {
      this.logger.warn(
        'No se encontraron los logos optimizados; el reporte saldrá sin ellos.',
      );
      this.logosCache = {};
      return this.logosCache;
    }

    this.logosCache = {
      actun: readFileSync(join(base, 'actun.png')),
      propeten: readFileSync(join(base, 'Propeten.png')),
    };
    return this.logosCache;
  }

  private anchoUtil(doc: PDFKit.PDFDocument): number {
    return doc.page.width - MARGEN.izquierdo - MARGEN.derecho;
  }

  /** Dónde deja de caber una fila: por debajo empieza la franja del pie. */
  private limiteInferior(doc: PDFKit.PDFDocument): number {
    return doc.page.height - MARGEN.inferior - 14;
  }

  /**
   * Recorta a lo ancho con puntos suspensivos.
   *
   * `ellipsis` de pdfkit solo actúa cuando el texto desborda **verticalmente** una caja
   * con `height`, así que para una celda de una línea hay que hacerlo a mano. La búsqueda
   * es binaria porque medir carácter a carácter se nota en una tabla de miles de filas.
   */
  private recortar(
    doc: PDFKit.PDFDocument,
    texto: string,
    ancho: number,
  ): string {
    if (ancho <= 0) return '';
    if (doc.widthOfString(texto) <= ancho) return texto;

    const puntos = '...';
    const anchoPuntos = doc.widthOfString(puntos);
    let bajo = 0;
    let alto = texto.length;

    while (bajo < alto) {
      const medio = Math.ceil((bajo + alto) / 2);
      if (doc.widthOfString(texto.slice(0, medio)) + anchoPuntos <= ancho)
        bajo = medio;
      else alto = medio - 1;
    }

    return bajo <= 0 ? puntos : `${texto.slice(0, bajo).trimEnd()}${puntos}`;
  }

  /**
   * Reparte el ancho entre las columnas.
   *
   * Las que declaran `ancho` toman esa fracción; el resto se reparte el sobrante **en
   * proporción a lo que miden sus datos**, no en partes iguales: si no, "Q1,250.00" queda
   * apretado al lado de un nombre de país al que le sobra la mitad del espacio.
   */
  private calcularAnchos(
    doc: PDFKit.PDFDocument,
    seccion: SeccionReporte,
    util: number,
  ): number[] {
    const { columnas, filas } = seccion;
    const fijos = columnas.map((c) => (c.ancho ? c.ancho * util : 0));
    const sumaFijos = fijos.reduce((a, b) => a + b, 0);
    const indicesAuto = columnas
      .map((_, i) => i)
      .filter((i) => !columnas[i].ancho);

    if (indicesAuto.length === 0) {
      // Se normaliza por si las fracciones no suman 1: la definición declara intención,
      // no aritmética exacta.
      const factor = sumaFijos > 0 ? util / sumaFijos : 1;
      return fijos.map((ancho) => ancho * factor);
    }

    // Muestreo intencional: medir cuarenta mil filas para decidir un ancho duplica el
    // tiempo de generación del PDF sin cambiar el resultado. No "arreglar" quitándolo.
    const muestra = filas.length > 200 ? filas.slice(0, 200) : filas;

    const pesos = indicesAuto.map((indice) => {
      const columna = columnas[indice];
      doc.font('Helvetica-Bold').fontSize(8);
      let maximo = doc.widthOfString(columna.titulo);
      doc.font('Helvetica').fontSize(8);
      for (const fila of muestra) {
        const ancho = doc.widthOfString(
          formatearCelda(fila[columna.clave], columna),
        );
        if (ancho > maximo) maximo = ancho;
      }
      return Math.max(maximo + RELLENO * 2, columna.anchoMinimo ?? 40);
    });

    const disponible = Math.max(util - sumaFijos, indicesAuto.length * 40);
    const sumaPesos = pesos.reduce((a, b) => a + b, 0) || 1;

    const anchos = [...fijos];
    indicesAuto.forEach((indice, posicion) => {
      anchos[indice] = (pesos[posicion] / sumaPesos) * disponible;
    });

    return anchos;
  }

  /**
   * Escribe una celda.
   *
   * Siempre con coordenadas y `lineBreak: false`: un `text()` sin coordenadas usa el flujo
   * automático de pdfkit y, cerca del margen inferior, dispara un `addPage()` implícito
   * que descuadra el conteo de páginas y mete hojas en blanco.
   */
  private celda(
    doc: PDFKit.PDFDocument,
    texto: string,
    x: number,
    y: number,
    ancho: number,
    columna: ColumnaReporte,
  ) {
    const interior = ancho - RELLENO * 2;
    doc.text(this.recortar(doc, texto, interior), x + RELLENO, y, {
      width: interior,
      align: ALINEACION_PDF[alineacionDe(columna)],
      lineBreak: false,
    });
  }

  private dibujarEncabezadoTabla(
    doc: PDFKit.PDFDocument,
    columnas: ColumnaReporte[],
    anchos: number[],
    y: number,
  ): number {
    const util = anchos.reduce((a, b) => a + b, 0);
    doc
      .rect(MARGEN.izquierdo, y, util, ALTO_ENCABEZADO_TABLA)
      .fill(COLOR.encabezado);

    let x = MARGEN.izquierdo;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.texto);
    columnas.forEach((columna, indice) => {
      this.celda(doc, columna.titulo, x, y + 6, anchos[indice], columna);
      x += anchos[indice];
    });

    doc
      .moveTo(MARGEN.izquierdo, y + ALTO_ENCABEZADO_TABLA)
      .lineTo(MARGEN.izquierdo + util, y + ALTO_ENCABEZADO_TABLA)
      .lineWidth(0.7)
      .strokeColor(COLOR.linea)
      .stroke();

    return y + ALTO_ENCABEZADO_TABLA;
  }

  private dibujarFilaTotales(
    doc: PDFKit.PDFDocument,
    seccion: SeccionReporte,
    anchos: number[],
    y: number,
  ): number {
    const totales = seccion.totales;
    if (!totales) return y;

    // La fila de totales no se separa nunca de su tabla: sola al principio de una página
    // no se entiende de qué es total.
    if (y + ALTO_TOTALES > this.limiteInferior(doc)) {
      doc.addPage();
      y = this.dibujarEncabezadoTabla(
        doc,
        seccion.columnas,
        anchos,
        MARGEN.superior,
      );
    }

    const util = anchos.reduce((a, b) => a + b, 0);
    doc
      .moveTo(MARGEN.izquierdo, y)
      .lineTo(MARGEN.izquierdo + util, y)
      .lineWidth(1)
      .strokeColor(COLOR.texto)
      .stroke();

    let x = MARGEN.izquierdo;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.texto);

    seccion.columnas.forEach((columna, indice) => {
      const valor = totales[columna.clave];
      const vacio = valor === undefined || valor === null || valor === '';
      const texto =
        indice === 0 && vacio
          ? 'TOTAL'
          : vacio
            ? ''
            : formatearCelda(valor, columna);
      this.celda(doc, texto, x, y + 5, anchos[indice], columna);
      x += anchos[indice];
    });

    return y + ALTO_TOTALES + 6;
  }

  private dibujarTabla(
    doc: PDFKit.PDFDocument,
    seccion: SeccionReporte,
    y: number,
  ): number {
    const anchos = this.calcularAnchos(doc, seccion, this.anchoUtil(doc));
    const util = anchos.reduce((a, b) => a + b, 0);
    let cursor = this.dibujarEncabezadoTabla(doc, seccion.columnas, anchos, y);

    if (seccion.filas.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLOR.gris);
      doc.text(
        'Sin datos para los filtros aplicados.',
        MARGEN.izquierdo + RELLENO,
        cursor + 6,
        {
          width: util,
          lineBreak: false,
        },
      );
      return cursor + ALTO_FILA + 8;
    }

    seccion.filas.forEach((fila, indice) => {
      if (cursor + ALTO_FILA > this.limiteInferior(doc)) {
        doc.addPage();
        // Se ignora `doc.y` y se lleva el cursor a mano: mezclar el flujo automático con
        // coordenadas absolutas es lo que produce páginas en blanco intercaladas.
        cursor = this.dibujarEncabezadoTabla(
          doc,
          seccion.columnas,
          anchos,
          MARGEN.superior,
        );
      }

      if (indice % 2 === 1) {
        doc.rect(MARGEN.izquierdo, cursor, util, ALTO_FILA).fill(COLOR.cebra);
      }

      let x = MARGEN.izquierdo;
      doc.font('Helvetica').fontSize(8).fillColor(COLOR.texto);
      seccion.columnas.forEach((columna, columnaIndice) => {
        const valor: ValorCelda = fila[columna.clave] ?? null;
        this.celda(
          doc,
          formatearCelda(valor, columna),
          x,
          cursor + 4.5,
          anchos[columnaIndice],
          columna,
        );
        x += anchos[columnaIndice];
      });

      cursor += ALTO_FILA;
    });

    return this.dibujarFilaTotales(doc, seccion, anchos, cursor);
  }

  private dibujarEncabezado(
    doc: PDFKit.PDFDocument,
    reporte: ResultadoReporte,
  ): number {
    const logos = this.cargarLogos();
    const util = this.anchoUtil(doc);
    let y = MARGEN.superior;

    if (logos.propeten && logos.actun) {
      const anchoActun = ALTO_LOGO * (170 / 140);
      doc.image(logos.propeten, MARGEN.izquierdo, y, { height: ALTO_LOGO });
      doc.image(logos.actun, doc.page.width - MARGEN.derecho - anchoActun, y, {
        height: ALTO_LOGO,
      });
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor(COLOR.texto)
      .text(reporte.titulo, MARGEN.izquierdo, y + 2, {
        width: util,
        align: 'center',
        lineBreak: false,
      });

    if (reporte.subtitulo) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLOR.gris)
        .text(reporte.subtitulo, MARGEN.izquierdo, y + 19, {
          width: util,
          align: 'center',
          lineBreak: false,
        });
    }

    y += ALTO_LOGO + 12;

    if (reporte.periodo) {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLOR.acento)
        .text(`Período: ${reporte.periodo.etiqueta}`, MARGEN.izquierdo, y, {
          width: util,
          align: 'center',
          lineBreak: false,
        });
      y += 13;
    }

    // Los filtros se imprimen siempre: un reporte sin constancia de con qué se generó no
    // sirve para auditar nada.
    const linea = reporte.filtrosAplicados.length
      ? reporte.filtrosAplicados
          .map((f) => `${f.etiqueta}: ${f.valor}`)
          .join('   ·   ')
      : 'Sin filtros adicionales';

    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.gris);
    doc.text(linea, MARGEN.izquierdo, y, { width: util, align: 'center' });
    // Aquí sí se usa doc.y: el texto puede envolver en varias líneas y su alto es variable.
    y = doc.y + 6;

    doc
      .moveTo(MARGEN.izquierdo, y)
      .lineTo(MARGEN.izquierdo + util, y)
      .lineWidth(1)
      .strokeColor(COLOR.acento)
      .stroke();

    return y + 12;
  }

  private dibujarKpis(
    doc: PDFKit.PDFDocument,
    reporte: ResultadoReporte,
    y: number,
  ): number {
    if (reporte.kpis.length === 0) return y;

    const util = this.anchoUtil(doc);
    const porFila = Math.min(reporte.kpis.length, KPIS_POR_FILA);
    const separacion = 8;
    const ancho = (util - separacion * (porFila - 1)) / porFila;

    reporte.kpis.forEach((kpi, indice) => {
      const fila = Math.floor(indice / porFila);
      const columna = indice % porFila;
      const x = MARGEN.izquierdo + columna * (ancho + separacion);
      const yTarjeta = y + fila * (ALTO_KPI + separacion);

      doc
        .roundedRect(x, yTarjeta, ancho, ALTO_KPI, 4)
        .lineWidth(0.8)
        .strokeColor(COLOR.linea)
        .stroke();

      doc
        .font('Helvetica')
        .fontSize(6.5)
        .fillColor(COLOR.gris)
        .text(kpi.etiqueta.toUpperCase(), x + 8, yTarjeta + 7, {
          width: ancho - 16,
          lineBreak: false,
        });

      doc
        .font('Helvetica-Bold')
        .fontSize(kpi.valor.length > 12 ? 11 : 14)
        .fillColor(COLOR.texto)
        .text(kpi.valor, x + 8, yTarjeta + 18, {
          width: ancho - 16,
          lineBreak: false,
        });

      if (kpi.detalle) {
        doc
          .font('Helvetica')
          .fontSize(6)
          .fillColor(COLOR.gris)
          .text(kpi.detalle, x + 8, yTarjeta + 33, {
            width: ancho - 16,
            lineBreak: false,
          });
      }
    });

    const filas = Math.ceil(reporte.kpis.length / porFila);
    return y + filas * (ALTO_KPI + separacion) + 6;
  }

  private dibujarNotas(
    doc: PDFKit.PDFDocument,
    reporte: ResultadoReporte,
    y: number,
  ) {
    if (!reporte.notas?.length) return;

    const util = this.anchoUtil(doc);
    const alto = 14 + reporte.notas.length * 20;

    if (y + alto > this.limiteInferior(doc)) {
      doc.addPage();
      y = MARGEN.superior;
    }

    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOR.gris);
    doc.text('NOTAS', MARGEN.izquierdo, y, { width: util, lineBreak: false });
    y += 11;

    doc.font('Helvetica').fontSize(7).fillColor(COLOR.gris);
    for (const nota of reporte.notas) {
      doc.text(`•  ${nota}`, MARGEN.izquierdo, y, { width: util });
      y = doc.y + 3;
    }
  }

  /**
   * Estampa el pie en todas las páginas, ya sabiendo cuántas son.
   *
   * `bufferPages: true` mantiene las páginas en memoria hasta `doc.end()`; ese es el
   * precio de poder numerarlas, y también el motivo del tope de filas.
   */
  private estamparPies(doc: PDFKit.PDFDocument, pie: string) {
    const rango = doc.bufferedPageRange();

    for (let i = rango.start; i < rango.start + rango.count; i++) {
      doc.switchToPage(i);

      // Sin esto pdfkit considera que el pie invade el margen inferior, añade una página
      // nueva y el bucle deja de coincidir con el rango: el PDF termina con una hoja en
      // blanco por cada página numerada.
      const margenOriginal = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;

      const util = this.anchoUtil(doc);
      const yPie = doc.page.height - MARGEN.inferior + 8;

      doc.font('Helvetica').fontSize(7).fillColor(COLOR.gris);
      doc.text(pie, MARGEN.izquierdo, yPie, {
        width: util * 0.72,
        align: 'left',
        lineBreak: false,
      });
      doc.text(
        `Página ${i - rango.start + 1} de ${rango.count}`,
        MARGEN.izquierdo + util * 0.72,
        yPie,
        {
          width: util * 0.28,
          align: 'right',
          lineBreak: false,
        },
      );

      doc.page.margins.bottom = margenOriginal;
    }
  }

  async generar(reporte: ResultadoReporte): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'LETTER',
      layout: reporte.orientacion === 'horizontal' ? 'landscape' : 'portrait',
      margins: {
        top: MARGEN.superior,
        bottom: MARGEN.inferior,
        left: MARGEN.izquierdo,
        right: MARGEN.derecho,
      },
      // Imprescindible para poder numerar "Página X de Y".
      bufferPages: true,
      info: {
        Title: reporte.titulo,
        Author: 'Actún Kan',
        Creator: 'actunkan-backend',
      },
    });

    const trozos: Buffer[] = [];
    doc.on('data', (trozo: Buffer) => trozos.push(trozo));
    const terminado = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(trozos)));
    });

    let y = this.dibujarEncabezado(doc, reporte);
    y = this.dibujarKpis(doc, reporte, y);

    reporte.secciones.forEach((seccion, indice) => {
      const altoMinimo =
        ALTO_ENCABEZADO_TABLA + ALTO_FILA * 3 + (seccion.titulo ? 16 : 0);
      if (
        indice > 0 &&
        (seccion.saltoDePaginaAntes ||
          y + altoMinimo > this.limiteInferior(doc))
      ) {
        doc.addPage();
        y = MARGEN.superior;
      }

      if (seccion.titulo) {
        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .fillColor(COLOR.texto)
          .text(seccion.titulo, MARGEN.izquierdo, y, { lineBreak: false });
        y += 16;
      }

      y = this.dibujarTabla(doc, seccion, y) + 12;
    });

    this.dibujarNotas(doc, reporte, y);

    const generado = reporte.generadoEn.slice(0, 16).replace('T', ' ');
    this.estamparPies(
      doc,
      `Actún Kan · Generado por ${reporte.generadoPor} el ${generado}`,
    );

    doc.end();
    return terminado;
  }
}
