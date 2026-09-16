import { TicketPdfService } from './ticket-pdf.service';
import { firmarNumeroTicket } from '../common/utils/qr.util';
import * as zlib from 'zlib';

const NUMERO = 'TCK-2026-000054';

const ticketBase = (extra: any = {}) => ({
  numeroTicket: NUMERO,
  qrFirma: firmarNumeroTicket(NUMERO),
  tipoTicket: 'VISITANTE',
  nombre: 'Manuel Castellanos',
  cantidadPersonas: 1,
  montoTotal: '20.0000',
  fechaCreacion: new Date('2026-08-14T15:00:00Z'),
  atraccion: { nombre: 'Biblioteca ambiental' },
  origen: { nombre: 'Nacional' },
  pais: null,
  ...extra,
});

/** El ancho del PDF viene declarado en el MediaBox. */
const medidas = (pdf: Buffer) => {
  const texto = pdf.toString('latin1');
  const m = texto.match(/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)!;
  return { ancho: parseFloat(m[3]), alto: parseFloat(m[4]) };
};

describe('TicketPdfService', () => {
  let service: TicketPdfService;

  beforeEach(() => {
    service = new TicketPdfService();
  });

  it('genera un PDF válido', async () => {
    const pdf = await service.generar(ticketBase());

    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('usa el ancho de 80 mm del rollo de tickets', async () => {
    const { ancho } = medidas(await service.generar(ticketBase()));

    // 80 mm = 226.77 pt
    expect(Math.round((ancho / 72) * 25.4)).toBe(80);
  });

  it('ajusta el alto al contenido: un nombre largo produce una página más alta', async () => {
    const corto = medidas(await service.generar(ticketBase({ nombre: 'Ana' })));
    const largo = medidas(
      await service.generar({
        ...ticketBase(),
        nombre: 'María Fernanda de los Ángeles Rodríguez Xoc de la Cruz',
      }),
    );

    expect(largo.alto).toBeGreaterThan(corto.alto);
  });

  it('reserva espacio extra para el país cuando el visitante es extranjero', async () => {
    const nacional = medidas(await service.generar(ticketBase()));
    const extranjero = medidas(
      await service.generar(
        ticketBase({ origen: { nombre: 'Extranjero' }, pais: { nombre: 'España' } }),
      ),
    );

    expect(extranjero.alto).toBeGreaterThan(nacional.alto);
  });

  it('no arrastra los megabytes de los logos originales', async () => {
    const pdf = await service.generar(ticketBase());

    // Con los logos sin optimizar cada pase rondaría los 2 MB.
    expect(pdf.length).toBeLessThan(200 * 1024);
  });

  it('reserva espacio para el desglose por categoría', async () => {
    const sinDesglose = medidas(await service.generar(ticketBase()));
    const conDesglose = medidas(
      await service.generar(
        ticketBase({
          cantidadPersonas: 5,
          montoTotal: '70.0000',
          visitantePorTickets: [
            { cantidad: 2, subtotal: '40', tipoVisitantes: { nombre: 'Adulto' } },
            { cantidad: 3, subtotal: '30', tipoVisitantes: { nombre: 'Niño (7 años o más)' } },
          ],
        }),
      ),
    );

    expect(conDesglose.alto).toBeGreaterThan(sinDesglose.alto);
  });

  it('ignora las categorías con cantidad 0', async () => {
    const soloUna = medidas(
      await service.generar(
        ticketBase({
          visitantePorTickets: [
            { cantidad: 1, subtotal: '20', tipoVisitantes: { nombre: 'Adulto' } },
            { cantidad: 0, subtotal: '0', tipoVisitantes: { nombre: 'Niño menor de 7 años' } },
          ],
        }),
      ),
    );
    const equivalente = medidas(
      await service.generar(
        ticketBase({
          visitantePorTickets: [
            { cantidad: 1, subtotal: '20', tipoVisitantes: { nombre: 'Adulto' } },
          ],
        }),
      ),
    );

    expect(soloUna.alto).toBe(equivalente.alto);
  });

  it('el pase de guía no lleva desglose', async () => {
    const pdf = await service.generar(
      ticketBase({ tipoTicket: 'GUIA', visitantePorTickets: [] }),
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('genera el pase del guía sin fallar', async () => {
    const pdf = await service.generar(
      ticketBase({ tipoTicket: 'GUIA', nombre: "Pedro Ak'abal", montoTotal: '15.0000' }),
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('funciona aunque el ticket no traiga atracción ni origen', async () => {
    const pdf = await service.generar(ticketBase({ atraccion: null, origen: null }));

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('usa la etiqueta "Pago pendiente" cuando el ticket tiene un pago sin confirmar', async () => {
    const spy = jest.spyOn<any, any>(service, 'caja');

    const pdf = await service.generar(
      ticketBase({
        ticketPagos: [{ anulado: false, estadoPago: 'PENDIENTE' }],
      }),
    );

    expect(pdf.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      'Pago pendiente',
      expect.any(String),
      expect.anything(),
    );
  });

  it('usa la etiqueta "Monto pagado" cuando el ticket ya está pagado', async () => {
    const spy = jest.spyOn<any, any>(service, 'caja');

    const pdf = await service.generar(
      ticketBase({
        ticketPagos: [{ anulado: false, estadoPago: 'PAGADO' }],
      }),
    );

    expect(pdf.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      'Monto pagado',
      expect.any(String),
      expect.anything(),
    );
  });

  /**
   * Un ticket con tarjeta que se anula sin pagar salía rotulado «Monto pagado»:
   * al anularlo se marcan sus pagos como anulados, y la única señal de
   * «pendiente» que miraba el PDF era que hubiera un pago pendiente **sin
   * anular**. El documento afirmaba un cobro que nunca ocurrió.
   */
  describe('ticket anulado', () => {
    const anuladoConTarjeta = () =>
      ticketBase({
        anulado: true,
        ticketPagos: [{ anulado: true, estadoPago: 'PENDIENTE' }],
      });

    it('no dice "Monto pagado" en un ticket anulado sin cobrar', async () => {
      const spy = jest.spyOn<any, any>(service, 'caja');

      const pdf = await service.generar(anuladoConTarjeta());

      expect(pdf.length).toBeGreaterThan(0);
      expect(spy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        'Monto pagado',
        expect.any(String),
        expect.anything(),
      );
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        'Ticket anulado',
        expect.any(String),
        expect.anything(),
      );
    });

    /**
     * El sello se comprueba por el alto: la insignia «ANULADO · NO VÁLIDO»
     * reserva 26 pt sobre el mismo ticket vigente. No se comprueba por texto
     * porque pdfkit subsetea la fuente y en el flujo no queda nada legible.
     */
    it('reserva el espacio de la insignia de anulado', async () => {
      const vigente = await service.generar(
        ticketBase({ ticketPagos: [{ anulado: false, estadoPago: 'PENDIENTE' }] }),
      );
      const anulado = await service.generar(anuladoConTarjeta());

      expect(medidas(anulado).alto).toBe(medidas(vigente).alto + 26);
      expect(medidas(anulado).ancho).toBe(medidas(vigente).ancho);
    });

    it('tampoco lo dice cuando el pago llegó a confirmarse antes de anular', async () => {
      const spy = jest.spyOn<any, any>(service, 'caja');

      await service.generar(
        ticketBase({
          anulado: true,
          ticketPagos: [{ anulado: true, estadoPago: 'PAGADO' }],
        }),
      );

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        'Ticket anulado',
        expect.any(String),
        expect.anything(),
      );
    });

    it('un ticket vigente con pago sin confirmar sigue diciendo "Pago pendiente"', async () => {
      const spy = jest.spyOn<any, any>(service, 'caja');

      await service.generar(
        ticketBase({ ticketPagos: [{ anulado: false, estadoPago: 'PENDIENTE' }] }),
      );

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        'Pago pendiente',
        expect.any(String),
        expect.anything(),
      );
    });
  });
});
