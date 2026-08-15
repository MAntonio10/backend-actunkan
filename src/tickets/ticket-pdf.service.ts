import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { construirPayloadQr } from '../common/utils/qr.util';
import { TIPO_TICKET_GUIA } from './tickets.service';

/** Ancho de rollo de 80 mm expresado en puntos PDF (1 pt = 1/72"). */
const ANCHO = 226.8;
const MARGEN = 14;
const CONTENIDO = ANCHO - MARGEN * 2;

const COLOR = {
  texto: '#1C1C1A',
  gris: '#7A7A75',
  /** Las cajas van sin relleno: en impresora térmica cualquier fondo sale como mancha. */
  borde: '#000000',
  linea: '#9A9A94',
};

/**
 * Acento por tipo de pase. La térmica imprime en blanco y negro, pero el PDF
 * descargado se distingue de un vistazo: verde para el visitante, ámbar para el guía.
 */
const ACENTO = {
  VISITANTE: '#2F6B3D',
  GUIA: '#B07D00',
};

const ALTO_LOGO = 30;
const LADO_QR = 116;
const ALTO_LINEA_DETALLE = 13;

@Injectable()
export class TicketPdfService {
  private readonly logger = new Logger(TicketPdfService.name);
  private logosCache: { actun?: Buffer; propeten?: Buffer } | null = null;

  /**
   * Los logos se leen de `logos/optimizados`, generados por
   * `scripts/optimizar-logos.ts`. Los originales pesan más de 1 MB cada uno y
   * harían que cada pase rondara los 2 MB.
   */
  private cargarLogos() {
    if (this.logosCache) return this.logosCache;

    const posibles = [
      join(process.cwd(), 'logos', 'optimizados'),
      join(__dirname, '..', '..', '..', 'logos', 'optimizados'),
    ];
    const base = posibles.find((ruta) => existsSync(join(ruta, 'actun.png')));

    if (!base) {
      // El pase se emite igual sin logos: es preferible a no poder imprimir.
      this.logger.warn('No se encontraron los logos optimizados; el PDF saldrá sin ellos.');
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

  /**
   * Caja con etiqueta a la izquierda y valor a la derecha.
   * Solo contorno, sin relleno: un fondo sólido sale como mancha oscura en térmica.
   */
  private caja(
    doc: any,
    y: number,
    etiqueta: string,
    valor: string,
    opciones: { fuenteValor?: string; tamValor?: number; colorValor?: string } = {},
  ): number {
    const alto = 28;
    doc
      .roundedRect(MARGEN, y, CONTENIDO, alto, 5)
      .lineWidth(0.9)
      .stroke(COLOR.borde);

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

  /** Línea punteada; con `muescas` dibuja los recortes laterales del recibo. */
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

  private etiquetaValor(
    doc: any,
    x: number,
    y: number,
    ancho: number,
    etiqueta: string,
    valor: string,
    opciones: { align?: 'left' | 'right'; color?: string; tam?: number } = {},
  ): number {
    const align = opciones.align ?? 'left';

    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(COLOR.gris)
      .text(etiqueta.toUpperCase(), x, y, { width: ancho, align, lineBreak: false });

    doc
      .font('Helvetica-Bold')
      .fontSize(opciones.tam ?? 11)
      .fillColor(opciones.color ?? COLOR.texto)
      .text(valor, x, y + 10, { width: ancho, align });

    return doc.y;
  }

  /**
   * Genera el pase de acceso en PDF. La página se dimensiona al contenido, de modo
   * que sirve tanto en impresora térmica de taquilla como en una de oficina.
   */
  async generar(ticket: any): Promise<Buffer> {
    const esGuia = ticket.tipoTicket === TIPO_TICKET_GUIA;
    const acento = esGuia ? ACENTO.GUIA : ACENTO.VISITANTE;
    const logos = this.cargarLogos();

    const payloadQr = construirPayloadQr(ticket.numeroTicket, ticket.qrFirma);
    const qrPng = await QRCode.toBuffer(payloadQr, {
      type: 'png',
      width: 460,
      margin: 0,
      errorCorrectionLevel: 'M',
    });

    // Primera pasada: medir el alto real del nombre, que es lo único variable.
    const regla = new PDFDocument({ size: [ANCHO, 1000], margin: 0 });
    regla.font('Helvetica-Bold').fontSize(13);
    const altoNombre = regla.heightOfString(ticket.nombre, { width: CONTENIDO });
    regla.end();

    const hayPais = Boolean(ticket.pais?.nombre);
    const altoInsignia = esGuia ? 26 : 0;

    // Desglose por categoría. El pase de guía no lo lleva: es una sola persona.
    const detalle: Array<{ texto: string; monto: string }> = (ticket.visitantePorTickets ?? [])
      .filter((v: any) => v.cantidad > 0)
      .map((v: any) => ({
        texto: `${v.cantidad} × ${v.tipoVisitantes?.nombre ?? 'Visitante'}`,
        monto: this.moneda(v.subtotal),
      }));
    const altoDetalle = detalle.length ? 12 + detalle.length * ALTO_LINEA_DETALLE + 10 : 0;

    const alto =
      18 + ALTO_LOGO + 10 + 20 + 12 + altoInsignia + 14 + 14 + 28 + 8 + 28 + 16 + 10 +
      altoNombre + 14 + 26 + 14 + 26 + (hayPais ? 24 : 0) + altoDetalle + 14 + 28 + 18 + 18 +
      30 + 16 + LADO_QR + 22 + 12 + 18;

    const doc = new PDFDocument({ size: [ANCHO, alto], margin: 0 });
    const trozos: Buffer[] = [];
    doc.on('data', (t: Buffer) => trozos.push(t));

    const terminado = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(trozos)));
    });

    doc.rect(0, 0, ANCHO, alto).fill('#FFFFFF');

    // Marco del color de acento: es lo que distingue de un vistazo el pase de guía
    // del de visitante al descargarlo. Solo contorno, para no cargar tinta.
    doc
      .roundedRect(5, 5, ANCHO - 10, alto - 10, 8)
      .lineWidth(1.6)
      .stroke(acento);

    let y = 18;

    // --- Encabezado: logos, nombre del parque y tipo de pase ---
    if (logos.propeten && logos.actun) {
      const anchoPro = ALTO_LOGO * (124 / 140);
      const anchoAct = ALTO_LOGO * (170 / 140);
      const separacion = 12;
      const total = anchoPro + separacion + anchoAct;
      const inicio = (ANCHO - total) / 2;

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
      .text(esGuia ? 'PASE DE GUÍA' : 'PASE DE ACCESO', 0, y, {
        width: ANCHO,
        align: 'center',
      });
    y += 12;

    // El pase de guía se cobra aparte del grupo: conviene que se lea sin ambigüedad.
    if (esGuia) {
      const anchoInsignia = 118;
      const xInsignia = (ANCHO - anchoInsignia) / 2;

      doc
        .roundedRect(xInsignia, y + 2, anchoInsignia, 16, 8)
        .lineWidth(1)
        .stroke(acento);

      doc
        .font('Helvetica-Bold')
        .fontSize(7)
        .fillColor(acento)
        .text('GUÍA SIN CARNET', xInsignia, y + 7, {
          width: anchoInsignia,
          align: 'center',
          lineBreak: false,
        });

      y += 26;
    }
    y += 14;

    this.separador(doc, y);
    y += 14;

    // --- Datos del ticket ---
    y = this.caja(doc, y, 'No. Ticket', ticket.numeroTicket, {
      fuenteValor: 'Courier-Bold',
      tamValor: 10,
      colorValor: acento,
    });
    y += 8;

    y = this.caja(doc, y, 'Atracción', (ticket.atraccion?.nombre ?? '').toUpperCase(), {
      tamValor: 8.5,
    });
    y += 16;

    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(COLOR.gris)
      .text(esGuia ? 'GUÍA' : 'TITULAR / GRUPO', MARGEN, y, { lineBreak: false });
    y += 10;

    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(COLOR.texto)
      .text(ticket.nombre, MARGEN, y, { width: CONTENIDO });
    y += altoNombre + 14;

    const mitad = CONTENIDO / 2;
    this.etiquetaValor(doc, MARGEN, y, mitad, 'Fecha', this.fechaCorta(ticket.fechaCreacion));
    this.etiquetaValor(doc, MARGEN + mitad, y, mitad, 'Personas', `${ticket.cantidadPersonas} Pax`, {
      align: 'right',
    });
    y += 26;

    this.etiquetaValor(doc, MARGEN, y, CONTENIDO, 'Origen', ticket.origen?.nombre ?? '-', {
      color: acento,
    });
    y += 26;

    if (hayPais) {
      this.etiquetaValor(doc, MARGEN, y, CONTENIDO, 'País', ticket.pais.nombre, { tam: 10 });
      y += 24;
    }

    // --- Desglose por categoría de visitante ---
    if (detalle.length) {
      doc
        .font('Helvetica')
        .fontSize(6.5)
        .fillColor(COLOR.gris)
        .text('DETALLE', MARGEN, y, { lineBreak: false });
      y += 12;

      const anchoMonto = 52;
      const anchoTexto = CONTENIDO - anchoMonto - 6;

      for (const linea of detalle) {
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(COLOR.texto)
          .text(linea.texto, MARGEN, y, {
            width: anchoTexto,
            lineBreak: false,
            ellipsis: true,
          });

        doc
          .font('Helvetica-Bold')
          .fontSize(8)
          .fillColor(COLOR.texto)
          .text(linea.monto, MARGEN + anchoTexto + 6, y, {
            width: anchoMonto,
            align: 'right',
            lineBreak: false,
          });

        y += ALTO_LINEA_DETALLE;
      }
      y += 10;
    }

    let pagos: any[] = [];
    if (Array.isArray(ticket.ticketPagos)) {
      pagos = ticket.ticketPagos;
    } else if (ticket.ticketPagos?.create) {
      pagos = Array.isArray(ticket.ticketPagos.create)
        ? ticket.ticketPagos.create
        : [ticket.ticketPagos.create];
    } else if (ticket.ticketPagos && typeof ticket.ticketPagos === 'object') {
      pagos = [ticket.ticketPagos];
    }

    const tienePagoPendiente =
      ticket.estadoPago === 'Pago pendiente' ||
      ticket.estadoPago === 'PENDIENTE' ||
      pagos.some(
        (p: any) =>
          !p.anulado && (p.estadoPago === 'PENDIENTE' || p.estadoPago === 'Pago pendiente'),
      );

    const etiquetaMonto = tienePagoPendiente ? 'Pago pendiente' : 'Monto pagado';
    y += 14;
    y = this.caja(doc, y, etiquetaMonto, this.moneda(ticket.montoTotal), { tamValor: 11 });
    y += 18;

    // --- Total y QR ---
    this.separador(doc, y, true);
    y += 18;

    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(COLOR.gris)
      .text('TOTAL A PAGAR', MARGEN, y + 10, { lineBreak: false });

    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(COLOR.texto)
      .text(this.moneda(ticket.montoTotal), MARGEN, y, {
        width: CONTENIDO,
        align: 'right',
        lineBreak: false,
      });
    y += 30 + 16;

    const xQr = (ANCHO - LADO_QR) / 2;
    doc
      .roundedRect(xQr - 8, y - 8, LADO_QR + 16, LADO_QR + 16, 6)
      .lineWidth(0.9).stroke(COLOR.borde);
    doc.image(qrPng, xQr, y, { width: LADO_QR, height: LADO_QR });
    y += LADO_QR + 22;

    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(COLOR.gris)
      .text('ESCANEE PARA VALIDAR TICKET', 0, y, { width: ANCHO, align: 'center' });

    doc.end();
    return terminado;
  }
}
