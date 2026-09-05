/**
 * Integración del circuito offline contra la base de datos real.
 *
 * Las unitarias verifican las reglas con Prisma simulado; estas verifican lo que
 * solo se ve contra SQL Server: que el correlativo no repita folios, que el índice
 * único filtrado bloquee un `idLocal` duplicado, y que la venta caiga en la caja
 * del lote y sume al arqueo.
 *
 * ## Cuidado con los datos reales
 *
 * Emitir tickets altera el arqueo de la caja abierta. Por eso:
 *
 * 1. Si hay una caja real abierta, **se aborta**: no se toca la operación en curso.
 * 2. Se abre una caja de prueba propia, se trabaja sobre ella y al final se anula
 *    junto con todo lo que se creó.
 * 3. Los lotes quedan invalidados —su estado terminal— en vez de borrados.
 */
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { OfflineService } from '../src/tickets/offline.service';
import { CajasService } from '../src/cajas/cajas.service';
import { SesionesService } from '../src/auth/sesiones.service';
import { AuthService } from '../src/auth/auth.service';
import * as jwt from 'jsonwebtoken';
import { getFechaUTC6 } from '../src/common/utils/date.util';

const EJECUTOR = { id: 3, email: 'qa@test.com' };
const ETIQUETA = `QA-TEST-OFFLINE-${Date.now()}`;
const DISPOSITIVO = `qa-disp-${Date.now()}`;

const EFECTIVO = 1;
const TARJETA = 2;

jest.setTimeout(120_000);

describe('Circuito offline (integración)', () => {
  let prisma: PrismaClient;
  let offline: OfflineService;
  let cajas: CajasService;
  let auth: AuthService;
  let moduloApp: any;
  let idCajaPrueba: number;
  let catalogo: any;
  const lotesCreados: number[] = [];
  const cajasCreadas: number[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient();

    const cajaReal = await prisma.aperturaCaja.findFirst({
      where: { estado: { nombre: 'Abierta' }, anulado: false },
    });

    if (cajaReal) {
      throw new Error(
        `Hay una caja abierta real (ID ${cajaReal.id}). Se aborta para no alterar su arqueo.`,
      );
    }

    const ahora = getFechaUTC6();
    const caja = await prisma.aperturaCaja.create({
      data: {
        idUsuario: EJECUTOR.id,
        idEstado: 1, // Abierta
        montoInicial: '100.0000',
        observaciones: `${ETIQUETA} caja de prueba automatizada`,
        fechaCreacion: ahora,
        fechaActualizacion: ahora,
      },
    });
    idCajaPrueba = caja.id;
    cajasCreadas.push(caja.id);

    const [atraccion, origen, recorrido, tipoVisitante] = await Promise.all([
      prisma.atraccion.findFirst({ where: { anulado: false } }),
      prisma.origenVisitante.findFirst({ where: { codigo: 'nacional' } }),
      prisma.tipoRecorrido.findFirst({ where: { anulado: false } }),
      prisma.tipoVisitante.findFirst({ where: { codigo: 'adulto' } }),
    ]);

    catalogo = { atraccion, origen, recorrido, tipoVisitante };

    moduloApp = await Test.createTestingModule({ imports: [AppModule] }).compile();
    offline = moduloApp.get(OfflineService);
    cajas = moduloApp.get(CajasService);
    auth = moduloApp.get(AuthService);
  });

  afterAll(async () => {
    // Los tickets de prueba salen del arqueo con baja lógica, igual que en producción.
    const tickets = await prisma.ticket.findMany({
      where: { idAperturaCaja: { in: cajasCreadas } },
    });

    for (const t of tickets) {
      await prisma.ticketPago.updateMany({ where: { idTicket: t.id }, data: { anulado: true } });
    }
    await prisma.ticket.updateMany({
      where: { idAperturaCaja: { in: cajasCreadas } },
      data: { anulado: true, fechaActualizacion: getFechaUTC6() },
    });

    for (const idLote of lotesCreados) {
      const lote = await prisma.loteOffline.findUnique({ where: { id: idLote } });
      if (lote && lote.estado === 'ACTIVO') {
        await prisma.loteOffline.update({
          where: { id: idLote },
          data: { estado: 'INVALIDADO' },
        });
        await prisma.folioReservado.updateMany({
          where: { idLote, estado: 'RESERVADO' },
          data: { estado: 'INVALIDADO' },
        });
      }
    }

    await prisma.aperturaCaja.updateMany({
      where: { id: { in: cajasCreadas } },
      data: { anulado: true, fechaActualizacion: getFechaUTC6() },
    });

    // Nada de la prueba puede quedar contando en ninguna caja.
    const vivos = await prisma.ticket.count({
      where: { idAperturaCaja: { in: cajasCreadas }, anulado: false },
    });
    expect(vivos).toBe(0);

    await prisma.$disconnect();
  });

  const venta = (extra: any = {}) => ({
    // UUID real: son exactamente los 36 caracteres de la columna. Un identificador
    // más largo lo rechaza SQL Server por truncamiento, no la validación.
    idLocal: randomUUID(),
    fechaEmision: new Date(Date.now() - 60_000).toISOString(),
    montoCobrado: '20.00',
    nombreGrupo: `${ETIQUETA} grupo`,
    idAtraccion: catalogo.atraccion.id,
    idOrigen: catalogo.origen.id,
    idTipoRecorrido: catalogo.recorrido.id,
    cantidades: [{ idTipoVisitante: catalogo.tipoVisitante.id, cantidad: 1 }],
    idOpcionPago: EFECTIVO,
    ...extra,
  });

  const reservar = async (cantidad: number, dispositivo = DISPOSITIVO) => {
    const lote = await offline.reservar({ cantidad, idDispositivo: dispositivo }, EJECUTOR);
    lotesCreados.push(lote.idLote);
    return lote;
  };

  describe('reserva de folios', () => {
    it('entrega folios firmados y únicos, atados a la caja abierta', async () => {
      const lote = await reservar(4);

      expect(lote.folios).toHaveLength(4);
      expect(lote.idAperturaCaja).toBe(idCajaPrueba);

      const numeros = lote.folios.map((f: any) => f.numeroTicket);
      expect(new Set(numeros).size).toBe(4);
    });

    /**
     * El error clásico de este diseño: dos caminos que leen el último número por
     * separado. Reserva y emisión online comparten `generarCorrelativo`.
     */
    it('no repite folios entre dos lotes consecutivos', async () => {
      const a = await reservar(3, `${DISPOSITIVO}-a`);
      const b = await reservar(3, `${DISPOSITIVO}-b`);

      const todos = [...a.folios, ...b.folios].map((f: any) => f.numeroTicket);
      expect(new Set(todos).size).toBe(6);
    });

    it('un folio reservado no colisiona con ningún ticket existente', async () => {
      const lote = await reservar(2, `${DISPOSITIVO}-c`);

      const choques = await prisma.ticket.count({
        where: { numeroTicket: { in: lote.folios.map((f: any) => f.numeroTicket) } },
      });
      expect(choques).toBe(0);
    });

    it('rechaza un segundo lote activo para el mismo dispositivo', async () => {
      const dispositivo = `${DISPOSITIVO}-dup`;
      await reservar(1, dispositivo);

      await expect(
        offline.reservar({ cantidad: 1, idDispositivo: dispositivo }, EJECUTOR),
      ).rejects.toMatchObject({ response: { codigo: 'LOTE_ACTIVO_EXISTENTE' } });
    });
  });

  describe('recuperar el lote activo', () => {
    it('devuelve los folios de ese dispositivo y usuario', async () => {
      const dispositivo = `${DISPOSITIVO}-rec`;
      const lote = await reservar(2, dispositivo);

      const recuperado = await offline.obtenerActivo(dispositivo, EJECUTOR);

      expect(recuperado.hayLoteActivo).toBe(true);
      expect(recuperado.lote!.idLote).toBe(lote.idLote);
      expect(recuperado.lote!.folios).toHaveLength(2);
    });

    // Vuelve a exponer folios pre-firmados: no puede servir desde otra sesión.
    it('no expone los folios a otro usuario', async () => {
      const dispositivo = `${DISPOSITIVO}-ajeno`;
      await reservar(1, dispositivo);

      const otro = await offline.obtenerActivo(dispositivo, { id: 4, email: 'otro@test.com' });

      expect(otro.hayLoteActivo).toBe(false);
    });
  });

  describe('subida de ventas', () => {
    it('convierte el folio en ticket real y lo marca EMITIDO', async () => {
      const lote = await reservar(2, `${DISPOSITIVO}-e1`);
      const folio = lote.folios[0];

      const res = await offline.emitirOffline(
        { idLote: lote.idLote, ventas: [venta({ numeroTicket: folio.numeroTicket })] },
        EJECUTOR,
      );

      expect(res.procesadas).toBe(1);
      expect(res.resultados[0].estado).toBe('CREADO');

      const ticket = await prisma.ticket.findUnique({
        where: { numeroTicket: folio.numeroTicket },
      });
      expect(ticket).not.toBeNull();
      expect(ticket!.origenOffline).toBe(true);
      expect(ticket!.idAperturaCaja).toBe(idCajaPrueba);
      // La firma del pase impreso tiene que seguir siendo válida.
      expect(ticket!.qrFirma).toBe(folio.firma);

      const actualizado = await prisma.folioReservado.findUnique({
        where: { numeroTicket: folio.numeroTicket },
      });
      expect(actualizado!.estado).toBe('EMITIDO');
      expect(actualizado!.idTicket).toBe(ticket!.id);
    });

    /**
     * El índice único filtrado sobre `idLocal` es lo que hace segura la
     * reintentabilidad. Si se perdiera, esto duplicaría tickets en silencio.
     */
    it('reintentar la misma venta no crea un segundo ticket', async () => {
      const lote = await reservar(2, `${DISPOSITIVO}-e2`);
      const cuerpo = {
        idLote: lote.idLote,
        ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket })],
      };

      const primera = await offline.emitirOffline(cuerpo, EJECUTOR);
      const segunda = await offline.emitirOffline(cuerpo, EJECUTOR);

      expect(primera.resultados[0].estado).toBe('CREADO');
      expect(segunda.resultados[0].estado).toBe('DUPLICADO_IGNORADO');

      const cuantos = await prisma.ticket.count({
        where: { idLocal: cuerpo.ventas[0].idLocal },
      });
      expect(cuantos).toBe(1);
    });

    it('rechaza la tarjeta: sin pasarela no hay cobro', async () => {
      const lote = await reservar(1, `${DISPOSITIVO}-e3`);

      const res = await offline.emitirOffline(
        {
          idLote: lote.idLote,
          ventas: [
            venta({ numeroTicket: lote.folios[0].numeroTicket, idOpcionPago: TARJETA }),
          ],
        },
        EJECUTOR,
      );

      expect(res.resultados[0].codigo).toBe('PAGO_NO_EFECTIVO');
      expect(await prisma.ticket.count({ where: { numeroTicket: lote.folios[0].numeroTicket } })).toBe(0);
    });

    it('rechaza un folio de otro lote sin frenar el resto', async () => {
      const propio = await reservar(2, `${DISPOSITIVO}-e4`);
      const ajeno = await reservar(1, `${DISPOSITIVO}-e5`);

      const res = await offline.emitirOffline(
        {
          idLote: propio.idLote,
          ventas: [
            venta({ numeroTicket: ajeno.folios[0].numeroTicket }),
            venta({ numeroTicket: propio.folios[0].numeroTicket }),
          ],
        },
        EJECUTOR,
      );

      expect(res.resultados[0].codigo).toBe('FOLIO_DE_OTRO_LOTE');
      expect(res.resultados[1].estado).toBe('CREADO');
      expect(res.procesadas).toBe(1);
    });

    it('el reloj adelantado del dispositivo no manda la venta al futuro', async () => {
      const lote = await reservar(1, `${DISPOSITIVO}-e6`);
      const futuro = new Date(Date.now() + 5 * 86_400_000).toISOString();

      await offline.emitirOffline(
        {
          idLote: lote.idLote,
          ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket, fechaEmision: futuro })],
        },
        EJECUTOR,
      );

      const ticket = await prisma.ticket.findUnique({
        where: { numeroTicket: lote.folios[0].numeroTicket },
      });
      expect(ticket!.fechaEmisionOffline!.getTime()).toBeLessThanOrEqual(
        getFechaUTC6().getTime() + 1000,
      );
    });

    it('un cobro de menos se registra igual y deja la diferencia anotada', async () => {
      const lote = await reservar(1, `${DISPOSITIVO}-e7`);

      const res = await offline.emitirOffline(
        {
          idLote: lote.idLote,
          ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket, montoCobrado: '5.00' })],
        },
        EJECUTOR,
      );

      expect(res.resultados[0].estado).toBe('CREADO');
      expect(res.resultados[0].discrepancia).not.toBeNull();

      const ticket = await prisma.ticket.findUnique({
        where: { numeroTicket: lote.folios[0].numeroTicket },
      });
      // Lo cobrado es lo que entró al cajón; lo recalculado es lo que correspondía.
      expect(Number(ticket!.montoTotal)).toBe(5);
      expect(Number(ticket!.montoRecalculado)).toBeGreaterThan(5);
    });

    /**
     * El caso reportado: 1 adulto nacional (Q20) + guía sin carnet (Q15) = Q35.
     * El total se le asignaba entero al ticket del visitante, así que el arqueo
     * contaba 35 + 15 = 50 con 35 en el cajón y el cajero quedaba con un faltante
     * de Q15 que no existía.
     */
    it('con guía sin carnet, el monto se reparte y el arqueo no cuenta doble', async () => {
      const lote = await reservar(2, `${DISPOSITIVO}-guia`);
      const guia = await prisma.tarifaGuia.findFirst({ where: { vigenteHasta: null } });
      const precioGuia = Number(guia!.precio);

      const tarifaAdulto = await prisma.tarifa.findFirst({
        where: {
          idAtraccion: catalogo.atraccion.id,
          idOrigen: catalogo.origen.id,
          idTipoVisitante: catalogo.tipoVisitante.id,
          vigenteHasta: null,
          anulado: false,
        },
      });
      const precioAdulto = Number(tarifaAdulto!.precio);
      const total = precioAdulto + precioGuia;

      const antes = await prisma.ticketPago.aggregate({
        _sum: { monto: true },
        where: {
          anulado: false,
          estadoPago: 'PAGADO',
          opcionPago: { esEfectivo: true },
          tickets: { idAperturaCaja: idCajaPrueba, anulado: false },
        },
      });

      const res = await offline.emitirOffline(
        {
          idLote: lote.idLote,
          ventas: [
            venta({
              numeroTicket: lote.folios[0].numeroTicket,
              numeroTicketGuia: lote.folios[1].numeroTicket,
              montoCobrado: total.toFixed(2),
              guia: { modo: 'nuevo', nombre: `${ETIQUETA} Pedro`, tieneCarnet: false },
            }),
          ],
        },
        EJECUTOR,
      );

      expect(res.resultados[0].estado).toBe('CREADO');
      expect(res.resultados[0].discrepancia).toBeNull();

      const visitante = await prisma.ticket.findUnique({
        where: { numeroTicket: lote.folios[0].numeroTicket },
      });
      const ticketGuia = await prisma.ticket.findUnique({
        where: { numeroTicket: lote.folios[1].numeroTicket },
      });

      expect(Number(visitante!.montoTotal)).toBe(precioAdulto);
      expect(Number(ticketGuia!.montoTotal)).toBe(precioGuia);
      expect(visitante!.montoRecalculado).toBeNull();

      // Lo que de verdad importa: al cajón entraron `total`, y eso suma el arqueo.
      const despues = await prisma.ticketPago.aggregate({
        _sum: { monto: true },
        where: {
          anulado: false,
          estadoPago: 'PAGADO',
          opcionPago: { esEfectivo: true },
          tickets: { idAperturaCaja: idCajaPrueba, anulado: false },
        },
      });

      expect(Number(despues._sum.monto) - Number(antes._sum.monto ?? 0)).toBe(total);
    });

    it('la venta suma al arqueo de la caja del lote', async () => {
      const antes = await prisma.ticketPago.aggregate({
        _sum: { monto: true },
        where: {
          anulado: false,
          estadoPago: 'PAGADO',
          opcionPago: { esEfectivo: true },
          tickets: { idAperturaCaja: idCajaPrueba, anulado: false },
        },
      });

      const lote = await reservar(1, `${DISPOSITIVO}-e8`);
      await offline.emitirOffline(
        {
          idLote: lote.idLote,
          ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket, montoCobrado: '33.00' })],
        },
        EJECUTOR,
      );

      const despues = await prisma.ticketPago.aggregate({
        _sum: { monto: true },
        where: {
          anulado: false,
          estadoPago: 'PAGADO',
          opcionPago: { esEfectivo: true },
          tickets: { idAperturaCaja: idCajaPrueba, anulado: false },
        },
      });

      expect(Number(despues._sum.monto) - Number(antes._sum.monto ?? 0)).toBe(33);
    });
  });

  describe('conciliación', () => {
    it('los folios sin vender pasan a NO_UTILIZADO y el lote queda cerrado', async () => {
      const lote = await reservar(3, `${DISPOSITIVO}-c1`);
      await offline.emitirOffline(
        { idLote: lote.idLote, ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket })] },
        EJECUTOR,
      );

      const res = await offline.conciliar(lote.idLote, {}, EJECUTOR);

      expect(res.emitidos).toBe(1);
      expect(res.noUtilizados).toBe(2);
      expect(res.estado).toBe('CONCILIADO');

      const sinUsar = await prisma.folioReservado.count({
        where: { idLote: lote.idLote, estado: 'NO_UTILIZADO' },
      });
      expect(sinUsar).toBe(2);
    });

    it('un folio declarado vendido sin ticket sale como advertencia', async () => {
      const lote = await reservar(2, `${DISPOSITIVO}-c2`);

      const res = await offline.conciliar(
        lote.idLote,
        { foliosUtilizados: [lote.folios[0].numeroTicket] },
        EJECUTOR,
      );

      expect(res.estado).toBe('CONCILIADO');
      expect(res.advertencias).toHaveLength(1);
      expect(res.advertencias[0].numeroTicket).toBe(lote.folios[0].numeroTicket);
    });

    it('conciliado el lote, sus folios ya no pueden emitirse', async () => {
      const lote = await reservar(2, `${DISPOSITIVO}-c3`);
      await offline.conciliar(lote.idLote, {}, EJECUTOR);

      const res = await offline.emitirOffline(
        { idLote: lote.idLote, ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket })] },
        EJECUTOR,
      );

      expect(res.resultados[0].codigo).toBe('FOLIO_NO_RESERVADO');
    });
  });

  describe('invalidación', () => {
    it('inutiliza los folios pendientes y bloquea subidas posteriores', async () => {
      const lote = await reservar(2, `${DISPOSITIVO}-i1`);

      const res = await offline.invalidar(lote.idLote, EJECUTOR);
      expect(res.foliosInvalidados).toBe(2);

      const subida = await offline.emitirOffline(
        { idLote: lote.idLote, ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket })] },
        EJECUTOR,
      );
      expect(subida.resultados[0].codigo).toBe('LOTE_INVALIDADO');
    });

    it('no toca las ventas ya registradas', async () => {
      const lote = await reservar(2, `${DISPOSITIVO}-i2`);
      await offline.emitirOffline(
        { idLote: lote.idLote, ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket })] },
        EJECUTOR,
      );

      const res = await offline.invalidar(lote.idLote, EJECUTOR);

      expect(res.foliosInvalidados).toBe(1);
      const emitido = await prisma.folioReservado.findUnique({
        where: { numeroTicket: lote.folios[0].numeroTicket },
      });
      expect(emitido!.estado).toBe('EMITIDO');
    });
  });

  describe('cierre de caja con lote offline pendiente', () => {
    /**
     * Se prueba en una caja propia y aparte: cerrar de verdad la caja principal
     * dejaría el resto de las pruebas sin dónde emitir.
     */
    const abrirCajaPropia = async () => {
      const ahora = getFechaUTC6();
      const caja = await prisma.aperturaCaja.create({
        data: {
          idUsuario: EJECUTOR.id,
          idEstado: 1,
          montoInicial: '50.0000',
          observaciones: `${ETIQUETA} caja de cierre`,
          fechaCreacion: ahora,
          fechaActualizacion: ahora,
        },
      });
      cajasCreadas.push(caja.id);
      return caja;
    };

    /** Crea un lote atado a una caja concreta, sin pasar por `reservar`. */
    const loteEn = async (idCaja: number) => {
      const ahora = getFechaUTC6();
      const lote = await prisma.loteOffline.create({
        data: {
          idUsuario: EJECUTOR.id,
          idAperturaCaja: idCaja,
          idDispositivo: `${DISPOSITIVO}-cierre-${idCaja}`,
          estado: 'ACTIVO',
          fechaCreacion: ahora,
          expiraEn: new Date(Date.now() + 86_400_000),
        },
      });
      lotesCreados.push(lote.id);

      await prisma.folioReservado.create({
        data: {
          idLote: lote.id,
          numeroTicket: `QA-CIERRE-${lote.id}`,
          firma: 'f'.repeat(64),
          estado: 'RESERVADO',
        },
      });

      return lote;
    };

    it('409 mientras el lote siga activo', async () => {
      const caja = await abrirCajaPropia();
      const lote = await loteEn(caja.id);

      await expect(cajas.cerrarCaja(caja.id, { montoContado: 50 }, EJECUTOR)).rejects.toMatchObject(
        { response: { codigo: 'LOTE_OFFLINE_PENDIENTE', idLote: lote.id, foliosReservados: 1 } },
      );

      const sigueAbierta = await prisma.aperturaCaja.findUnique({ where: { id: caja.id } });
      expect(sigueAbierta!.idEstado).toBe(1);
    });

    it('conciliado el lote, la caja cierra normalmente', async () => {
      const caja = await abrirCajaPropia();
      const lote = await loteEn(caja.id);

      await offline.conciliar(lote.id, {}, EJECUTOR);
      const res = await cajas.cerrarCaja(caja.id, { montoContado: 50 }, EJECUTOR);

      expect(res.cierre).toBeDefined();
    });

    /**
     * El escenario que deja la operación trabada: el lote vence de noche, a la
     * mañana el dispositivo reserva otro, y el viejo queda en ACTIVO. Si bloqueara
     * el cierre, esa caja no podría cerrarse nunca —nadie va a conciliar un lote
     * que el dispositivo ya reemplazó— y, como solo puede haber una caja abierta,
     * se bloquearía todo el parque.
     */
    it('un lote vencido no traba el cierre: se concilia solo', async () => {
      const caja = await abrirCajaPropia();
      const lote = await loteEn(caja.id);

      // Se le adelanta el vencimiento, como si hubiera pasado la noche. Se usa una
      // fecha claramente pasada: `expiraEn` se compara contra `getFechaUTC6()`, que
      // va 6 horas atrás, así que "hace una hora" todavía contaría como vigente.
      await prisma.loteOffline.update({
        where: { id: lote.id },
        data: { expiraEn: new Date(Date.now() - 2 * 86_400_000) },
      });

      await expect(
        cajas.cerrarCaja(caja.id, { montoContado: 50 }, EJECUTOR),
      ).resolves.toBeDefined();

      const cerrado = await prisma.loteOffline.findUnique({ where: { id: lote.id } });
      expect(cerrado!.estado).toBe('CONCILIADO');
      expect(cerrado!.fechaConciliacion).not.toBeNull();

      const folios = await prisma.folioReservado.findMany({ where: { idLote: lote.id } });
      expect(folios.every((f) => f.estado === 'NO_UTILIZADO')).toBe(true);
    });

    // El frontend solo conoce su lote actual; el anterior lo cierra el backend.
    it('reservar un lote nuevo concilia el vencido del mismo dispositivo', async () => {
      const dispositivo = `${DISPOSITIVO}-relevo`;
      const viejo = await reservar(2, dispositivo);

      await prisma.loteOffline.update({
        where: { id: viejo.idLote },
        data: { expiraEn: new Date(Date.now() - 2 * 86_400_000) },
      });

      const nuevo = await reservar(2, dispositivo);

      expect(nuevo.idLote).not.toBe(viejo.idLote);

      const cerrado = await prisma.loteOffline.findUnique({ where: { id: viejo.idLote } });
      expect(cerrado!.estado).toBe('CONCILIADO');

      const folios = await prisma.folioReservado.findMany({ where: { idLote: viejo.idLote } });
      expect(folios.every((f) => f.estado === 'NO_UTILIZADO')).toBe(true);
    });

    it('forzar invalida el lote y deja cerrar', async () => {
      const caja = await abrirCajaPropia();
      const lote = await loteEn(caja.id);

      await cajas.cerrarCaja(
        caja.id,
        { montoContado: 50, forzarLoteOffline: true },
        EJECUTOR,
      );

      const invalidado = await prisma.loteOffline.findUnique({ where: { id: lote.id } });
      expect(invalidado!.estado).toBe('INVALIDADO');

      const folios = await prisma.folioReservado.findMany({ where: { idLote: lote.id } });
      expect(folios.every((f) => f.estado === 'INVALIDADO')).toBe(true);
    });
  });

  describe('discrepancia offline en el arqueo', () => {
    it('un cobro de menos aparece en el arqueo sin mover el monto esperado', async () => {
      const lote = await reservar(1, `${DISPOSITIVO}-arq`);

      const antes = await cajas.arqueo(idCajaPrueba);

      await offline.emitirOffline(
        {
          idLote: lote.idLote,
          ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket, montoCobrado: '7.00' })],
        },
        EJECUTOR,
      );

      const despues = await cajas.arqueo(idCajaPrueba);

      // El esperado sube solo por lo cobrado: es el dinero que hay en el cajón.
      expect(despues.montoEsperado - antes.montoEsperado).toBe(7);

      expect(despues.discrepanciaOffline).not.toBeNull();
      expect(Number(despues.discrepanciaOffline!.diferencia)).toBeLessThan(0);
    });
  });

  /**
   * El taquillero al que dan de baja mientras está sin conexión. Sus ventas ya se
   * cobraron; bloquearlo no las deshace, solo deja la caja con dinero que ningún
   * ticket respalda.
   */
  describe('usuario anulado con ventas pendientes de liquidar', () => {
    let sesiones: SesionesService;
    let idUsuarioBaja: number;

    /** Da de baja al usuario y devuelve una función para restituirlo. */
    const darDeBaja = async (id: number) => {
      await prisma.usuario.update({ where: { id }, data: { anulado: true } });
      return async () => {
        await prisma.usuario.update({ where: { id }, data: { anulado: false } });
      };
    };

    const nuevaSesion = async (idUsuario: number) => {
      const { refreshToken } = await sesiones.crear(idUsuario, true, {});
      return refreshToken;
    };

    beforeAll(() => {
      sesiones = moduloApp.get(SesionesService);
      idUsuarioBaja = EJECUTOR.id;
    });

    it('con un lote activo puede renovar su sesión, con alcance reducido', async () => {
      const lote = await reservar(1, `${DISPOSITIVO}-baja1`);
      const token = await nuevaSesion(idUsuarioBaja);
      const restituir = await darDeBaja(idUsuarioBaja);

      try {
        const res: any = await auth.refrescar(token, {});

        expect(res.solo_sincronizacion).toBe(true);
        expect(res.access_token).toBeDefined();

        // El token declara su alcance; el guard es quien lo hace cumplir.
        const payload: any = jwt.decode(res.access_token);
        expect(payload.soloSincronizacion).toBe(true);
      } finally {
        await restituir();
        await offline.invalidar(lote.idLote, EJECUTOR).catch(() => undefined);
      }
    });

    it('todavía puede subir y conciliar lo que ya vendió', async () => {
      const lote = await reservar(2, `${DISPOSITIVO}-baja2`);
      const restituir = await darDeBaja(idUsuarioBaja);

      try {
        const res = await offline.emitirOffline(
          {
            idLote: lote.idLote,
            ventas: [venta({ numeroTicket: lote.folios[0].numeroTicket })],
          },
          EJECUTOR,
        );
        expect(res.resultados[0].estado).toBe('CREADO');

        const conciliado = await offline.conciliar(lote.idLote, {}, EJECUTOR);
        expect(conciliado.estado).toBe('CONCILIADO');
      } finally {
        await restituir();
      }
    });

    // Sin nada que liquidar, la baja es total.
    it('sin lote pendiente, la sesión no se renueva', async () => {
      const token = await nuevaSesion(idUsuarioBaja);

      await prisma.loteOffline.updateMany({
        where: { idUsuario: idUsuarioBaja, estado: 'ACTIVO' },
        data: { estado: 'INVALIDADO' },
      });

      const restituir = await darDeBaja(idUsuarioBaja);

      try {
        await expect(auth.refrescar(token, {})).rejects.toThrow(/deshabilitado/i);
      } finally {
        await restituir();
      }
    });

    it('el usuario vuelve a quedar activo después de las pruebas', async () => {
      const usuario = await prisma.usuario.findUnique({ where: { id: idUsuarioBaja } });
      expect(usuario!.anulado).toBe(false);
    });
  });

  describe('un folio reservado no es un pase válido', () => {
    /**
     * Su firma es criptográficamente correcta, pero no corresponde a ninguna venta.
     * Vive en `FolioReservado`, no en `Ticket`, así que la validación no lo
     * encuentra. Si algún día alguien "optimizara" la búsqueda incluyendo esa
     * tabla, esto sería entrada gratis.
     */
    it('no existe como ticket mientras no se venda', async () => {
      const lote = await reservar(1, `${DISPOSITIVO}-v1`);

      const comoTicket = await prisma.ticket.findUnique({
        where: { numeroTicket: lote.folios[0].numeroTicket },
      });

      expect(comoTicket).toBeNull();
    });
  });
});
