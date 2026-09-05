import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { TicketsService } from './tickets.service';
import {
  FOLIO_EMITIDO,
  FOLIO_INVALIDADO,
  FOLIO_NO_UTILIZADO,
  FOLIO_RESERVADO,
  LOTE_ACTIVO,
  LOTE_CONCILIADO,
  LOTE_INVALIDADO,
  OfflineService,
} from './offline.service';

const EJECUTOR = { id: 3, email: 'cajero@test.com' };
const CAJA_DEL_LOTE = 12;
const OTRA_CAJA = 99;

const loteBase = (extra: any = {}) => ({
  id: 7,
  idUsuario: EJECUTOR.id,
  idAperturaCaja: CAJA_DEL_LOTE,
  idDispositivo: 'disp-1',
  estado: LOTE_ACTIVO,
  fechaCreacion: new Date(Date.now() - 8 * 3600_000),
  expiraEn: new Date(Date.now() + 8 * 3600_000),
  folios: [],
  ...extra,
});

const folioBase = (extra: any = {}) => ({
  id: 100,
  idLote: 7,
  numeroTicket: 'TCK-2026-000101',
  firma: 'f'.repeat(64),
  estado: FOLIO_RESERVADO,
  idTicket: null,
  ...extra,
});

const ventaBase = (extra: any = {}) => ({
  idLocal: 'uuid-1',
  numeroTicket: 'TCK-2026-000101',
  fechaEmision: new Date(Date.now() - 4 * 3600_000).toISOString(),
  montoCobrado: '40.00',
  nombreGrupo: 'Familia Rodríguez',
  idAtraccion: 1,
  idOrigen: 1,
  idTipoRecorrido: 1,
  cantidades: [{ idTipoVisitante: 1, cantidad: 2 }],
  idOpcionPago: 1,
  ...extra,
});

describe('OfflineService', () => {
  let service: OfflineService;
  let prisma: any;
  let tx: any;
  let tickets: any;

  beforeEach(async () => {
    tx = {
      aperturaCaja: {
        findUnique: jest.fn().mockResolvedValue({
          id: CAJA_DEL_LOTE,
          anulado: false,
          estado: { nombre: 'Abierta' },
        }),
      },
      usuario: { findUnique: jest.fn().mockResolvedValue({ id: 3, nombre: 'Cajero' }) },
      loteOffline: {
        findFirst: jest.fn().mockResolvedValue(null),
        // Lotes vencidos del dispositivo: por defecto ninguno.
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(({ data }: any) => Promise.resolve({ id: 7, ...data })),
        update: jest.fn(({ data }: any) => Promise.resolve({ ...loteBase(), ...data })),
      },
      folioReservado: {
        findUnique: jest.fn().mockResolvedValue(folioBase()),
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: Math.random(), ...data }),
        ),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      correlativo: {
        upsert: jest.fn().mockResolvedValue({ serie: 'TCK', anio: 2026, ultimoNumero: 101 }),
      },
      grupoEmision: { create: jest.fn().mockResolvedValue({ id: 55 }) },
      ticket: {
        create: jest.fn(({ data }: any) => Promise.resolve({ id: 900, ...data })),
        findUnique: jest.fn().mockResolvedValue({ id: 900, numeroTicket: 'TCK-2026-000101' }),
      },
      tarifaGuia: {
        findFirst: jest.fn().mockResolvedValue({ id: 1, precio: '15.0000' }),
      },
    };

    prisma = {
      $transaction: jest.fn((cb: any) => cb(tx)),
      ticket: { findFirst: jest.fn().mockResolvedValue(null) },
      loteOffline: { findUnique: jest.fn().mockResolvedValue(loteBase()) },
    };

    tickets = {
      prepararEmision: jest.fn().mockResolvedValue({
        atraccion: { id: 1, nombre: 'Cuevas' },
        origen: { id: 1, codigo: 'nacional', nombre: 'Nacional' },
        tipoRecorrido: { id: 1 },
        opcionPago: { id: 1, nombre: 'Efectivo', esEfectivo: true },
        idPais: null,
        detalles: [
          {
            idTipoVisitante: 1,
            cantidad: 2,
            precioUnitario: new Prisma.Decimal(20),
            subtotal: new Prisma.Decimal(40),
          },
        ],
        montoVisitantes: new Prisma.Decimal(40),
        totalPersonas: 2,
      }),
      resolverGuia: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue({ id: 900 }),
    };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        OfflineService,
        { provide: PrismaService, useValue: prisma },
        { provide: CajasService, useValue: { obtenerActual: jest.fn().mockResolvedValue({ id: CAJA_DEL_LOTE }) } },
        { provide: TicketsService, useValue: tickets },
      ],
    }).compile();

    service = modulo.get<OfflineService>(OfflineService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('reservar folios', () => {
    it('exige caja abierta', async () => {
      const cajas = { obtenerActual: jest.fn().mockResolvedValue(null) };
      const modulo = await Test.createTestingModule({
        providers: [
          OfflineService,
          { provide: PrismaService, useValue: prisma },
          { provide: CajasService, useValue: cajas },
          { provide: TicketsService, useValue: tickets },
        ],
      }).compile();

      await expect(
        modulo.get(OfflineService).reservar({ cantidad: 5, idDispositivo: 'd' }, EJECUTOR),
      ).rejects.toThrow(BadRequestException);
    });

    it('genera un folio por cada unidad pedida, con su firma', async () => {
      const lote = await service.reservar({ cantidad: 3, idDispositivo: 'disp-1' }, EJECUTOR);

      expect(tx.folioReservado.create).toHaveBeenCalledTimes(3);
      expect(lote.folios).toHaveLength(3);
      expect(lote.folios[0].firma).toHaveLength(64);
    });

    // Reproducir el formato a mano rompería los pases cuando cambie.
    it('arma el QR con el mismo formato JSON de la emisión online', async () => {
      const lote = await service.reservar({ cantidad: 1, idDispositivo: 'disp-1' }, EJECUTOR);

      const qr = JSON.parse(lote.folios[0].qr);
      expect(qr).toEqual({
        numeroTicket: lote.folios[0].numeroTicket,
        firma: lote.folios[0].firma,
      });
    });

    // Es el contador que comparte con la emisión online: sin eso, dos folios iguales.
    it('toma los números del correlativo global', async () => {
      await service.reservar({ cantidad: 2, idDispositivo: 'disp-1' }, EJECUTOR);

      expect(tx.correlativo.upsert).toHaveBeenCalledTimes(2);
    });

    it('rechaza con 409 si el dispositivo ya tiene un lote activo', async () => {
      tx.loteOffline.findFirst.mockResolvedValue(loteBase());

      await expect(
        service.reservar({ cantidad: 5, idDispositivo: 'disp-1' }, EJECUTOR),
      ).rejects.toThrow(ConflictException);
    });

    /**
     * Un lote vencido ya no sirve para vender; si bloqueara, el taquillero no
     * podría abrir turno al día siguiente.
     */
    it('un lote vencido no bloquea la reserva del día siguiente', async () => {
      await service.reservar({ cantidad: 1, idDispositivo: 'disp-1' }, EJECUTOR);

      const where = tx.loteOffline.findFirst.mock.calls[0][0].where;
      expect(where.estado).toBe(LOTE_ACTIVO);
      expect(where.expiraEn).toHaveProperty('gt');
    });

    /**
     * Si el vencido quedara en ACTIVO, su caja no podría cerrarse nunca: el
     * frontend solo conoce su lote "actual", que ya es otro, y el viejo puede ni
     * estar en el dispositivo. El backend lo cierra solo.
     */
    describe('lotes vencidos del dispositivo', () => {
      const conVencido = () =>
        tx.loteOffline.findMany.mockResolvedValue([
          { id: 5, idDispositivo: 'disp-1', expiraEn: new Date(Date.now() - 8 * 3600_000) },
        ]);

      it('se concilian al reservar el lote nuevo', async () => {
        conVencido();

        await service.reservar({ cantidad: 1, idDispositivo: 'disp-1' }, EJECUTOR);

        expect(tx.loteOffline.update).toHaveBeenCalledWith({
          where: { id: 5 },
          data: expect.objectContaining({ estado: LOTE_CONCILIADO }),
        });
        expect(tx.folioReservado.updateMany).toHaveBeenCalledWith({
          where: { idLote: 5, estado: FOLIO_RESERVADO },
          data: { estado: FOLIO_NO_UTILIZADO },
        });
      });

      it('el lote nuevo se crea igual', async () => {
        conVencido();

        const lote = await service.reservar({ cantidad: 2, idDispositivo: 'disp-1' }, EJECUTOR);

        expect(lote.folios).toHaveLength(2);
      });

      it('solo busca los del mismo dispositivo, y solo los vencidos', async () => {
        await service.reservar({ cantidad: 1, idDispositivo: 'disp-1' }, EJECUTOR);

        const where = tx.loteOffline.findMany.mock.calls[0][0].where;
        expect(where.idDispositivo).toBe('disp-1');
        expect(where.estado).toBe(LOTE_ACTIVO);
        expect(where.expiraEn).toHaveProperty('lte');
      });

      it('queda registrado en bitácora', async () => {
        conVencido();

        await service.reservar({ cantidad: 1, idDispositivo: 'disp-1' }, EJECUTOR);

        expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({ accion: 'CONCILIAR_LOTE_OFFLINE_VENCIDO' }),
        );
      });
    });

    it('ata el lote a la caja abierta, no a una que mande el cliente', async () => {
      await service.reservar({ cantidad: 1, idDispositivo: 'disp-1' }, EJECUTOR);

      expect(tx.loteOffline.create.mock.calls[0][0].data.idAperturaCaja).toBe(CAJA_DEL_LOTE);
    });

    it('usa aislamiento Serializable', async () => {
      await service.reservar({ cantidad: 1, idDispositivo: 'disp-1' }, EJECUTOR);

      expect(prisma.$transaction.mock.calls[0][1].isolationLevel).toBe(
        Prisma.TransactionIsolationLevel.Serializable,
      );
    });
  });

  describe('recuperar lote activo', () => {
    it('exige que coincidan usuario y dispositivo', async () => {
      prisma.loteOffline.findFirst = jest.fn().mockResolvedValue(null);

      await service.obtenerActivo('disp-1', EJECUTOR);

      expect(prisma.loteOffline.findFirst.mock.calls[0][0].where).toMatchObject({
        idDispositivo: 'disp-1',
        idUsuario: EJECUTOR.id,
      });
    });

    it('devuelve el envoltorio explícito cuando no hay lote', async () => {
      prisma.loteOffline.findFirst = jest.fn().mockResolvedValue(null);

      await expect(service.obtenerActivo('disp-1', EJECUTOR)).resolves.toEqual({
        hayLoteActivo: false,
        lote: null,
      });
    });

    it('solo devuelve los folios que siguen reservados', async () => {
      prisma.loteOffline.findFirst = jest.fn().mockResolvedValue(
        loteBase({
          folios: [
            folioBase({ id: 1, numeroTicket: 'A', estado: FOLIO_RESERVADO }),
            folioBase({ id: 2, numeroTicket: 'B', estado: FOLIO_EMITIDO }),
            folioBase({ id: 3, numeroTicket: 'C', estado: FOLIO_NO_UTILIZADO }),
          ],
        }),
      );

      const res = await service.obtenerActivo('disp-1', EJECUTOR);

      expect(res.lote!.folios.map((f: any) => f.numeroTicket)).toEqual(['A']);
    });
  });

  describe('subir la cola de ventas', () => {
    it('rechaza el lote de otro usuario', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(loteBase({ idUsuario: 999 }));

      await expect(
        service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR),
      ).rejects.toThrow(BadRequestException);
    });

    it('404 si el lote no existe', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(null);

      await expect(
        service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR),
      ).rejects.toThrow(NotFoundException);
    });

    it('registra la venta y marca el folio como emitido', async () => {
      const res = await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(res.procesadas).toBe(1);
      expect(res.resultados[0].estado).toBe('CREADO');
      expect(tx.folioReservado.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { estado: FOLIO_EMITIDO, idTicket: 900 } }),
      );
    });

    // Es lo que permite reintentar tras un timeout ambiguo sin duplicar.
    it('un idLocal ya registrado no crea nada', async () => {
      prisma.ticket.findFirst.mockResolvedValue({ id: 900 });

      const res = await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(res.resultados[0].estado).toBe('DUPLICADO_IGNORADO');
      expect(tx.ticket.create).not.toHaveBeenCalled();
      expect(res.procesadas).toBe(0);
    });

    it('guarda el idLocal en el ticket, que es lo que hace posible detectarlo', async () => {
      await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(tx.ticket.create.mock.calls[0][0].data.idLocal).toBe('uuid-1');
    });

    /** La venta pertenece al turno del lote, no al de quien la sube. */
    it('la caja del ticket es la del lote, no la abierta al subir', async () => {
      await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(tx.ticket.create.mock.calls[0][0].data.idAperturaCaja).toBe(CAJA_DEL_LOTE);
      expect(tx.ticket.create.mock.calls[0][0].data.idAperturaCaja).not.toBe(OTRA_CAJA);
    });

    it('marca el ticket como de origen offline', async () => {
      await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(tx.ticket.create.mock.calls[0][0].data.origenOffline).toBe(true);
      expect(tx.ticket.create.mock.calls[0][0].data.idLoteOffline).toBe(7);
    });

    it('sin pasarela no hay tarjeta: rechaza toda forma de pago que no sea efectivo', async () => {
      tickets.prepararEmision.mockResolvedValue({
        ...(await tickets.prepararEmision()),
        opcionPago: { id: 2, nombre: 'Tarjeta', esEfectivo: false },
      });

      const res = await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(res.resultados[0].codigo).toBe('PAGO_NO_EFECTIVO');
    });

    it('rechaza un folio de otro lote', async () => {
      tx.folioReservado.findUnique.mockResolvedValue(folioBase({ idLote: 8 }));

      const res = await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(res.resultados[0].codigo).toBe('FOLIO_DE_OTRO_LOTE');
    });

    /**
     * Distinto de FOLIO_NO_RESERVADO: acá el dispositivo gastó dos veces el mismo
     * folio en ventas distintas, así que hay dinero cobrado que se va a perder.
     */
    it('distingue un folio ya gastado de uno inexistente', async () => {
      tx.folioReservado.findUnique.mockResolvedValue(
        folioBase({ estado: FOLIO_EMITIDO, idTicket: 500 }),
      );

      const res = await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(res.resultados[0].codigo).toBe('FOLIO_YA_EMITIDO');
    });

    it('rechaza un folio inexistente', async () => {
      tx.folioReservado.findUnique.mockResolvedValue(null);

      const res = await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(res.resultados[0].codigo).toBe('FOLIO_NO_RESERVADO');
    });

    it('rechaza todas las ventas de un lote invalidado', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(loteBase({ estado: LOTE_INVALIDADO }));

      const res = await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

      expect(res.resultados[0].codigo).toBe('LOTE_INVALIDADO');
    });

    // Una venta con datos malos no puede tumbar las otras 49, que son dinero real.
    it('una venta rechazada no impide las demás', async () => {
      tx.folioReservado.findUnique
        .mockResolvedValueOnce(folioBase({ idLote: 8 }))
        .mockResolvedValueOnce(folioBase({ numeroTicket: 'TCK-2026-000102' }));

      const res = await service.emitirOffline(
        {
          idLote: 7,
          ventas: [ventaBase(), ventaBase({ idLocal: 'uuid-2', numeroTicket: 'TCK-2026-000102' })],
        },
        EJECUTOR,
      );

      expect(res.resultados[0].estado).toBe('RECHAZADO');
      expect(res.resultados[1].estado).toBe('CREADO');
      expect(res.procesadas).toBe(1);
    });

    describe('el reloj del dispositivo no es confiable', () => {
      it('una fecha futura se acota a ahora', async () => {
        const futuro = new Date(Date.now() + 10 * 86400_000).toISOString();
        await service.emitirOffline(
          { idLote: 7, ventas: [ventaBase({ fechaEmision: futuro })] },
          EJECUTOR,
        );

        const usada: Date = tickets.prepararEmision.mock.calls[0][2];
        expect(usada.getTime()).toBeLessThanOrEqual(Date.now());
      });

      it('una fecha anterior al lote se acota a su creación', async () => {
        const lote = loteBase();
        prisma.loteOffline.findUnique.mockResolvedValue(lote);

        await service.emitirOffline(
          { idLote: 7, ventas: [ventaBase({ fechaEmision: '2020-01-01T00:00:00.000Z' })] },
          EJECUTOR,
        );

        const usada: Date = tickets.prepararEmision.mock.calls[0][2];
        expect(usada.getTime()).toBe(lote.fechaCreacion.getTime());
      });

      it('una fecha válida se respeta', async () => {
        const valida = new Date(Date.now() - 4 * 3600_000);
        await service.emitirOffline(
          { idLote: 7, ventas: [ventaBase({ fechaEmision: valida.toISOString() })] },
          EJECUTOR,
        );

        const usada: Date = tickets.prepararEmision.mock.calls[0][2];
        expect(usada.getTime()).toBe(valida.getTime());
      });

      // Sin esto, una venta de ayer se recalcularía con el precio de hoy.
      it('la tarifa se resuelve con la fecha de la venta, no con la de subida', async () => {
        await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

        expect(tickets.prepararEmision).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.any(Date),
        );
      });
    });

    describe('discrepancia entre lo cobrado y lo que correspondía', () => {
      it('si coinciden no guarda montoRecalculado', async () => {
        const res = await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

        expect(tx.ticket.create.mock.calls[0][0].data.montoRecalculado).toBeNull();
        expect(res.resultados[0].discrepancia).toBeNull();
      });

      /** El visitante ya pagó y ya entró: rechazar dejaría dinero sin ticket. */
      it('si difieren registra la venta igual y guarda la diferencia', async () => {
        const res = await service.emitirOffline(
          { idLote: 7, ventas: [ventaBase({ montoCobrado: '30.00' })] },
          EJECUTOR,
        );

        expect(res.resultados[0].estado).toBe('CREADO');
        expect(Number(tx.ticket.create.mock.calls[0][0].data.montoRecalculado)).toBe(40);
        expect(res.resultados[0].discrepancia).toEqual({
          montoCobrado: '30',
          montoRecalculado: '40',
          diferencia: '-10',
        });
      });

      // El arqueo cuenta el dinero del cajón, que es lo que se cobró.
      it('el pago se registra por lo cobrado, no por lo recalculado', async () => {
        await service.emitirOffline(
          { idLote: 7, ventas: [ventaBase({ montoCobrado: '30.00' })] },
          EJECUTOR,
        );

        const pago = tx.ticket.create.mock.calls[0][0].data.ticketPagos.create;
        expect(Number(pago.monto)).toBe(30);
        expect(pago.estadoPago).toBe('PAGADO');
      });
    });

    describe('guía', () => {
      // Offline es normal que el mismo guía nuevo acompañe a varios grupos.
      it('reutiliza un guía existente en vez de rechazar por nombre repetido', async () => {
        await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

        expect(tickets.resolverGuia).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.any(Date),
          true,
        );
      });

      /**
       * `montoCobrado` es el total de la venta (20 del visitante + 15 del guía).
       * Asignárselo entero al ticket del visitante y crear además el del guía por
       * su tarifa hacía que el arqueo contara 35 + 15 = 50 cuando al cajón habían
       * entrado 35, y el cajero aparecía con un faltante inexistente.
       */
      describe('reparto del monto entre los dos tickets', () => {
        /** El caso reportado: 1 adulto nacional (Q20) + guía sin carnet (Q15) = Q35. */
        const conGuia = () => {
          tickets.resolverGuia.mockResolvedValue({ id: 4, nombre: 'Pedro', tieneCarnet: false });
          tickets.prepararEmision.mockResolvedValue({
            atraccion: { id: 1, nombre: 'Cuevas' },
            origen: { id: 1, codigo: 'nacional', nombre: 'Nacional' },
            tipoRecorrido: { id: 1 },
            opcionPago: { id: 1, nombre: 'Efectivo', esEfectivo: true },
            idPais: null,
            detalles: [
              {
                idTipoVisitante: 1,
                cantidad: 1,
                precioUnitario: new Prisma.Decimal(20),
                subtotal: new Prisma.Decimal(20),
              },
            ],
            montoVisitantes: new Prisma.Decimal(20),
            totalPersonas: 1,
          });
          tx.folioReservado.findUnique
            .mockResolvedValueOnce(folioBase())
            .mockResolvedValueOnce(folioBase({ id: 101, numeroTicket: 'TCK-2026-000102' }));
        };

        const ventaConGuia = (montoCobrado = '35.00') =>
          ventaBase({ numeroTicketGuia: 'TCK-2026-000102', montoCobrado });

        const datos = (i: number) => tx.ticket.create.mock.calls[i][0].data;

        it('al visitante le corresponde el total menos la tarifa del guía', async () => {
          conGuia();

          await service.emitirOffline({ idLote: 7, ventas: [ventaConGuia('35.00')] }, EJECUTOR);

          expect(Number(datos(0).montoTotal)).toBe(20);
          expect(Number(datos(1).montoTotal)).toBe(15);
        });

        it('los pagos suman exactamente lo cobrado, sin contar dos veces al guía', async () => {
          conGuia();

          await service.emitirOffline({ idLote: 7, ventas: [ventaConGuia('35.00')] }, EJECUTOR);

          const pagoVisitante = Number(datos(0).ticketPagos.create.monto);
          const pagoGuia = Number(datos(1).ticketPagos.create.monto);

          expect(pagoVisitante).toBe(20);
          expect(pagoGuia).toBe(15);
          expect(pagoVisitante + pagoGuia).toBe(35);
        });

        // 20 + 15 = 35: no hay nada mal cobrado que reportar.
        it('un cobro correcto no genera discrepancia', async () => {
          conGuia();

          const res = await service.emitirOffline(
            { idLote: 7, ventas: [ventaConGuia('35.00')] },
            EJECUTOR,
          );

          expect(res.resultados[0].discrepancia).toBeNull();
          expect(datos(0).montoRecalculado).toBeNull();
          expect(datos(1).montoRecalculado).toBeNull();
        });

        it('la discrepancia se juzga sobre el total de la venta', async () => {
          conGuia();

          const res = await service.emitirOffline(
            { idLote: 7, ventas: [ventaConGuia('30.00')] },
            EJECUTOR,
          );

          expect(res.resultados[0].discrepancia).toEqual({
            montoCobrado: '30',
            montoRecalculado: '35',
            diferencia: '-5',
          });
        });

        // El faltante se refleja en el visitante; el guía conserva su tarifa.
        it('si se cobró de menos, el guía cobra su tarifa y el resto va al visitante', async () => {
          conGuia();

          await service.emitirOffline({ idLote: 7, ventas: [ventaConGuia('30.00')] }, EJECUTOR);

          expect(Number(datos(0).montoTotal)).toBe(15);
          expect(Number(datos(1).montoTotal)).toBe(15);
          // Lo que correspondía al visitante, para que la diferencia sea rastreable.
          expect(Number(datos(0).montoRecalculado)).toBe(20);
        });

        // Un monto negativo corrompería el arqueo.
        it('cobrar menos que la tarifa del guía no deja el visitante en negativo', async () => {
          conGuia();

          await service.emitirOffline({ idLote: 7, ventas: [ventaConGuia('10.00')] }, EJECUTOR);

          expect(Number(datos(0).montoTotal)).toBe(0);
          expect(Number(datos(1).montoTotal)).toBe(10);
          expect(Number(datos(1).montoRecalculado)).toBe(15);
        });

        // Sin guía, el visitante se lleva todo: no hay nada que repartir.
        it('una venta sin guía no cambia de comportamiento', async () => {
          const res = await service.emitirOffline({ idLote: 7, ventas: [ventaBase()] }, EJECUTOR);

          expect(Number(datos(0).montoTotal)).toBe(40);
          expect(res.resultados[0].discrepancia).toBeNull();
        });
      });

      it('el segundo folio genera el ticket del guía', async () => {
        tickets.resolverGuia.mockResolvedValue({ id: 4, nombre: 'Pedro', tieneCarnet: false });
        tx.folioReservado.findUnique
          .mockResolvedValueOnce(folioBase())
          .mockResolvedValueOnce(folioBase({ id: 101, numeroTicket: 'TCK-2026-000102' }));

        await service.emitirOffline(
          { idLote: 7, ventas: [ventaBase({ numeroTicketGuia: 'TCK-2026-000102' })] },
          EJECUTOR,
        );

        expect(tx.ticket.create).toHaveBeenCalledTimes(2);
        expect(tx.ticket.create.mock.calls[1][0].data.tipoTicket).toBe('GUIA');
      });

      // El idLocal identifica la venta, no el ticket: repetirlo rompería el único.
      it('el ticket del guía no repite el idLocal', async () => {
        tickets.resolverGuia.mockResolvedValue({ id: 4, nombre: 'Pedro', tieneCarnet: false });
        tx.folioReservado.findUnique
          .mockResolvedValueOnce(folioBase())
          .mockResolvedValueOnce(folioBase({ id: 101, numeroTicket: 'TCK-2026-000102' }));

        await service.emitirOffline(
          { idLote: 7, ventas: [ventaBase({ numeroTicketGuia: 'TCK-2026-000102' })] },
          EJECUTOR,
        );

        expect(tx.ticket.create.mock.calls[1][0].data.idLocal).toBeUndefined();
      });
    });
  });

  describe('conciliar', () => {
    it('los folios sin vender pasan a NO_UTILIZADO', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(
        loteBase({ folios: [folioBase(), folioBase({ id: 101, estado: FOLIO_EMITIDO })] }),
      );

      const res = await service.conciliar(7, {}, EJECUTOR);

      expect(tx.folioReservado.updateMany).toHaveBeenCalledWith({
        where: { idLote: 7, estado: FOLIO_RESERVADO },
        data: { estado: FOLIO_NO_UTILIZADO },
      });
      expect(res.noUtilizados).toBe(1);
      expect(res.emitidos).toBe(1);
      expect(res.estado).toBe(LOTE_CONCILIADO);
    });

    /**
     * Significa una venta que se perdió y hay que investigarla, pero bloquear la
     * conciliación dejaría la caja sin poder cerrarse.
     */
    it('un folio declarado vendido sin ticket avisa pero no falla', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(loteBase({ folios: [folioBase()] }));

      const res = await service.conciliar(
        7,
        { foliosUtilizados: ['TCK-2026-000140'] },
        EJECUTOR,
      );

      expect(res.estado).toBe(LOTE_CONCILIADO);
      expect(res.advertencias).toEqual([
        { numeroTicket: 'TCK-2026-000140', detalle: 'Declarado utilizado, sin ticket registrado' },
      ]);
    });

    it('no avisa por los folios que sí tienen ticket', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(
        loteBase({ folios: [folioBase({ estado: FOLIO_EMITIDO })] }),
      );

      const res = await service.conciliar(
        7,
        { foliosUtilizados: ['TCK-2026-000101'] },
        EJECUTOR,
      );

      expect(res.advertencias).toEqual([]);
    });

    it('rechaza conciliar dos veces', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(loteBase({ estado: LOTE_CONCILIADO }));

      await expect(service.conciliar(7, {}, EJECUTOR)).rejects.toThrow(BadRequestException);
    });

    it('404 si el lote no existe', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(null);

      await expect(service.conciliar(7, {}, EJECUTOR)).rejects.toThrow(NotFoundException);
    });
  });

  describe('invalidar', () => {
    it('los folios reservados quedan inutilizables', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(
        loteBase({ folios: [folioBase(), folioBase({ id: 101 })] }),
      );

      const res = await service.invalidar(7, EJECUTOR);

      expect(tx.folioReservado.updateMany).toHaveBeenCalledWith({
        where: { idLote: 7, estado: FOLIO_RESERVADO },
        data: { estado: FOLIO_INVALIDADO },
      });
      expect(res.foliosInvalidados).toBe(2);
      expect(res.estado).toBe(LOTE_INVALIDADO);
    });

    it('no toca los folios ya emitidos: esas ventas existen', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(
        loteBase({ folios: [folioBase({ estado: FOLIO_EMITIDO })] }),
      );

      const res = await service.invalidar(7, EJECUTOR);

      expect(res.foliosInvalidados).toBe(0);
    });

    it('rechaza invalidar dos veces', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(loteBase({ estado: LOTE_INVALIDADO }));

      await expect(service.invalidar(7, EJECUTOR)).rejects.toThrow(BadRequestException);
    });

    it('deja constancia en bitácora de que se pierden las ventas no subidas', async () => {
      prisma.loteOffline.findUnique.mockResolvedValue(loteBase({ folios: [folioBase()] }));

      await service.invalidar(7, EJECUTOR);

      expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ accion: 'INVALIDAR_LOTE_OFFLINE' }),
      );
    });
  });
});
