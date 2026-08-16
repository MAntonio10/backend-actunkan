import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import PDFDocument from 'pdfkit';

/** Mismo ancho de rollo que el pase de acceso: 80 mm. */
const ANCHO = 226.8;
const MARGEN = 14;
const CONTENIDO = ANCHO - MARGEN * 2;

const COLOR = {
  texto: '#1C1C1A',
  gris: '#7A7A75',
  /** Sin rellenos: en térmica cualquier fondo sale como mancha. */
  borde: '#000000',
  linea: '#9A9A94',
};

/** Azul, para distinguir el recibo de donación del pase de acceso (verde/ámbar). */
const ACENTO = '#1F5A7A';
const ACENTO_ANULADO = '#9B2226';

const ALTO_LOGO = 30;

@Injectable()
export class DonacionPdfService {
  private readonly logger = new Logger(DonacionPdfService.name);
  private logosCache: { actun?: Buffer; propeten?: Buffer } | null = null;

  private cargarLogos() {
    if (this.logosCache) return this.logosCache;

    const posibles = [
      join(process.cwd(), 'logos', 'optimizados'),
      join(__dirname, '..', '..', '..', 'logos', 'optimizados'),
    ];
    const base = posibles.find((ruta) => existsSync(join(ruta, 'actun.png')));

    if (!base) {
      this.logger.warn('No se encontraron los logos optimizados; el recibo saldrá sin ellos.');
      this.logosCache = {};
      return this.logosCache;
    }

    this.logosCache = {
      actun: readFileSync(join(base, 'actun.png')),
      propeten: readFileSync(join(base, 'Propeten.png')),
    };
    return this.logosCache;
  }

  private moneda(valor: any): string {
    return `Q${Number(valor).toFixed(2)}`;
  }

  private fechaCorta(fecha: Date): string {
    return new Date(fecha).toISOString().slice(0, 10);
  }

  /** Caja con etiqueta a la izquierda y valor a la derecha, solo contorno. */
  private caja(
    doc: any,
    y: number,
    etiqueta: string,
    valor: string,
    opciones: { fuenteValor?: string; tamValor?: number; colorValor?: string } = {},
  ): number {
    const alto = 28;
    doc.roundedRect(MARGEN, y, CONTENIDO, alto, 5).lineWidth(0.9).stroke(COLOR.borde);

    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(COLOR.gris)
      .text(etiqueta.toUpperCase(), MARGEN + 10, y + 11, { lineBreak: false });

    doc
      .font(opciones.fuenteValor ?? 'Helvetica-Bold')
      .fontSize(opciones.tamValor ?? 9)
      .fillColor(opciones.colorValor ?? COLOR.texto)
      .text(valor, MARGEN + 10, y + 10, {
        width: CONTENIDO - 20,
        align: 'right',
        lineBreak: false,
      });

    return y + alto;
  }

  private separador(doc: any, y: number, muescas = false) {
    if (muescas) {
      doc.circle(0, y, 6).fill('#FFFFFF');
      doc.circle(ANCHO, y, 6).fill('#FFFFFF');
    }

    doc
      .moveTo(MARGEN + (muescas ? 6 : 0), y)
      .lineTo(ANCHO - MARGEN - (muescas ? 6 : 0), y)
      .dash(2, { space: 2 })
      .strokeColor(COLOR.linea)
      .lineWidth(0.8)
      .stroke()
      .undash();
  }

  /**
   * Recibo **no contable** de donación. No tiene validez fiscal, y así lo declara
   * de forma visible: es lo que diferencia este documento de una factura.
   */
  async generar(donacion: any): Promise<Buffer> {
    const logos = this.cargarLogos();
    const anulado = Boolean(donacion.anulado);
    const acento = anulado ? ACENTO_ANULADO : ACENTO;
    const donante = donacion.nombreDonante || 'Donante anónimo';

    // Primera pasada: el nombre y las observaciones son lo único de alto variable.
    const regla = new PDFDocument({ size: [ANCHO, 1000], margin: 0 });
    regla.font('Helvetica-Bold').fontSize(13);
    const altoDonante = regla.heightOfString(donante, { width: CONTENIDO });
    regla.font('Helvetica').fontSize(8);
    const altoObs = donacion.observaciones
      ? regla.heightOfString(donacion.observaciones, { width: CONTENIDO }) + 12
      : 0;
    regla.end();

    const alto =
      18 + ALTO_LOGO + 10 + 20 + 12 + 14 + 14 + 28 + 8 + 28 + 16 + 10 + altoDonante + 14 +
      26 + 14 + altoObs + 18 + 18 + 30 + 20 + 30 + (anulado ? 26 : 0) + 18;

    const doc = new PDFDocument({ size: [ANCHO, alto], margin: 0 });
    const trozos: Buffer[] = [];
    doc.on('data', (t: Buffer) => trozos.push(t));
    const terminado = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(trozos)));
    });

    doc.rect(0, 0, ANCHO, alto).fill('#FFFFFF');
    doc.roundedRect(5, 5, ANCHO - 10, alto - 10, 8).lineWidth(1.6).stroke(acento);

    let y = 18;

    // --- Encabezado ---
    if (logos.propeten && logos.actun) {
      const anchoPro = ALTO_LOGO * (124 / 140);
      const anchoAct = ALTO_LOGO * (170 / 140);
      const separacion = 12;
      const inicio = (ANCHO - (anchoPro + separacion + anchoAct)) / 2;

      doc.image(logos.propeten, inicio, y, { height: ALTO_LOGO });
      doc
        .moveTo(inicio + anchoPro + separacion / 2, y + 4)
        .lineTo(inicio + anchoPro + separacion / 2, y + ALTO_LOGO - 4)
        .strokeColor(COLOR.linea)
        .lineWidth(0.8)
        .stroke();
      doc.image(logos.actun, inicio + anchoPro + separacion, y, { height: ALTO_LOGO });
    }
    y += ALTO_LOGO + 10;

    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor(COLOR.texto)
      .text('ACTÚN KAN', 0, y, { width: ANCHO, align: 'center' });
    y += 20;

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(acento)
      .text('RECIBO DE DONACIÓN', 0, y, { width: ANCHO, align: 'center' });
    y += 12 + 14;

    this.separador(doc, y);
    y += 14;

    // --- Datos del recibo ---
    y = this.caja(doc, y, 'No. Recibo', donacion.numeroRecibo, {
      fuenteValor: 'Courier-Bold',
      tamValor: 10,
      colorValor: acento,
    });
    y += 8;

    y = this.caja(doc, y, 'Forma de pago', 'EFECTIVO', { tamValor: 8.5 });
    y += 16;

    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(COLOR.gris)
      .text('DONANTE', MARGEN, y, { lineBreak: false });
    y += 10;

    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(COLOR.texto)
      .text(donante, MARGEN, y, { width: CONTENIDO });
    y += altoDonante + 14;

    const mitad = CONTENIDO / 2;
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(COLOR.gris)
      .text('FECHA', MARGEN, y, { width: mitad, lineBreak: false });
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(COLOR.gris)
      .text('RECIBIÓ', MARGEN + mitad, y, { width: mitad, align: 'right', lineBreak: false });

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLOR.texto)
      .text(this.fechaCorta(donacion.fechaCreacion), MARGEN, y + 10, { width: mitad });
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(COLOR.texto)
      .text(donacion.usuario?.nombre ?? '-', MARGEN + mitad, y + 11, {
        width: mitad,
        align: 'right',
        lineBreak: false,
      });
    y += 26;

    if (donacion.observaciones) {
      doc
        .font('Helvetica')
        .fontSize(6.5)
        .fillColor(COLOR.gris)
        .text('OBSERVACIONES', MARGEN, y, { lineBreak: false });
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(COLOR.texto)
        .text(donacion.observaciones, MARGEN, y + 10, { width: CONTENIDO });
      y += altoObs + 4;
    }

    y += 14;
    this.separador(doc, y, true);
    y += 18;

    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(COLOR.gris)
      .text('MONTO DONADO', MARGEN, y + 10, { lineBreak: false });

    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(anulado ? ACENTO_ANULADO : COLOR.texto)
      .text(this.moneda(donacion.monto), MARGEN, y, {
        width: CONTENIDO,
        align: 'right',
        lineBreak: false,
      });
    y += 30 + 20;

    // --- Sello de anulado ---
    if (anulado) {
      doc
        .roundedRect(MARGEN, y, CONTENIDO, 18, 9)
        .lineWidth(1.2)
        .stroke(ACENTO_ANULADO);
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(ACENTO_ANULADO)
        .text('RECIBO ANULADO', MARGEN, y + 5, {
          width: CONTENIDO,
          align: 'center',
          lineBreak: false,
        });
      y += 26;
    }

    // Lo que distingue este documento de una factura: debe leerse sin ambigüedad.
    doc
      .font('Helvetica-Bold')
      .fontSize(7)
      .fillColor(COLOR.gris)
      .text('DOCUMENTO NO CONTABLE', 0, y, { width: ANCHO, align: 'center' });
    doc
      .font('Helvetica')
      .fontSize(6)
      .fillColor(COLOR.gris)
      .text('Este recibo no tiene validez fiscal ni sustituye a una factura.', 0, y + 9, {
        width: ANCHO,
        align: 'center',
      });

    doc.end();
    return terminado;
  }
}
