/**
 * Integración del modelo VIGENTE de venta sin conexión: la taquilla firma sus pases.
 *
 * ## Por qué existe este archivo
 *
 * `offline.e2e-spec.ts` cubre el modelo por lote con 40 pruebas. El modelo por
 * dispositivo —el que usa la taquilla— tenía **cero** cobertura de integración, y eso
 * costó: el camino común sellaba el folio con `marcarEmitido`, que en este modo
 * recibe `id: null` porque no hay `FolioReservado` que sellar, y SQL Server rechazaba
 * la transacción entera con «Argument `id` must not be null». Ninguna venta firmada
 * por taquilla podía sincronizarse, y las 42 unitarias del modo pasaban todas porque
 * cortaban antes de escribir el ticket.
 *
 * Lo que solo se ve contra SQL Server y por eso se prueba acá: que el ticket se
 * escriba de verdad, que el pase firmado por el dispositivo valide, que la venta
 * sume al arqueo de su caja, y que el `@unique` de `numeroTicket` sea el que impide
 * el folio repetido ahora que no hay tabla de folios reservados.
 *
 * ## Cuidado con los datos reales
 *
 * Emitir tickets altera el arqueo. Misma disciplina que el otro archivo:
 *
 * 1. Si hay una caja real abierta, **se aborta**: no se toca la operación en curso.
 * 2. Se abre una caja de prueba propia y al final se anula con todo lo que creó.
 * 3. La taquilla de prueba queda **revocada**, que es su estado terminal, no borrada.
 */
import { Test } from '@nestjs/testing';
import { randomUUID, webcrypto } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { OfflineService } from '../src/tickets/offline.service';
import { DispositivosService } from '../src/dispositivos/dispositivos.service';
import { TicketsService } from '../src/tickets/tickets.service';
import { CajasService } from '../src/cajas/cajas.service';
import { getFechaUTC6, anioDeNegocio } from '../src/common/utils/date.util';

const EJECUTOR = { id: 3, email: 'qa@test.com' };
const ETIQUETA = `QA-TEST-DISP-${Date.now()}`;
const ID_DISPOSITIVO = `qa-disp-firma-${Date.now()}`;

const EFECTIVO = 1;
const TARJETA = 2;

jest.setTimeout(120_000);

/**
 * Una taquilla como la real: par ECDSA P-256 generado con WebCrypto, que es la misma
 * API que corre en el navegador de la tablet.
 *
 * La firma sale en formato `ieee-p1363` (r||s, 64 bytes crudos). Node verifica en DER
 * por omisión, así que el servidor tiene que pedir `dsaEncoding: 'ieee-p1363'`
 * explícitamente o rechaza toda firma legítima. Esta prueba lo ejercita de verdad:
 * si alguien quita esa opción, acá se cae.
 */
async function crearTaquillaLocal() {
  const par = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  const spki = await webcrypto.subtle.exportKey('spki', par.publicKey);

  return {
    llavePublica: Buffer.from(spki).toString('base64'),
    firmar: async (numeroTicket: string) => {
      const firma = await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        par.privateKey,
        new TextEncoder().encode(numeroTicket),
      );
      return Buffer.from(firma).toString('base64');
    },
  };
}

describe('Venta sin conexión firmada por la taquilla (integración)', () => {
  let prisma: PrismaClient;
  let offline: OfflineService;
  let dispositivos: DispositivosService;
  let ticketsService: TicketsService;
  let cajas: CajasService;
  let moduloApp: any;

  let taquilla: Awaited<ReturnType<typeof crearTaquillaLocal>>;
  let registro: any;
  let idCajaPrueba: number;
  let catalogo: any;

  const cajasCreadas: number[] = [];
  /** Correlativo local, para no pisar folios entre pruebas de este archivo. */
  let siguiente = 0;

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
    dispositivos = moduloApp.get(DispositivosService);
    ticketsService = moduloApp.get(TicketsService);
    cajas = moduloApp.get(CajasService);

    taquilla = await crearTaquillaLocal();
    registro = await dispositivos.registrar(
      {
        idDispositivo: ID_DISPOSITIVO,
        llavePublica: taquilla.llavePublica,
        nombre: `${ETIQUETA} taquilla`,
      } as any,
      EJECUTOR,
    );
  });

  afterAll(async () => {
    // Los tickets de prueba salen del arqueo con baja lógica, igual que en producción.
    const tickets = await prisma.ticket.findMany({
      where: { idAperturaCaja: { in: cajasCreadas } },
    });

    for (const t of tickets) {
      await prisma.ticketPago.updateMany({
        where: { idTicket: t.id },
        data: { anulado: true },
      });
    }

    await prisma.ticket.updateMany({
      where: { idAperturaCaja: { in: cajasCreadas } },
      data: { anulado: true, fechaActualizacion: getFechaUTC6() },
    });

    await prisma.aperturaCaja.updateMany({
      where: { id: { in: cajasCreadas } },
      data: { anulado: true, fechaActualizacion: getFechaUTC6() },
    });

    // Revocada, no borrada: es su estado terminal y los folios que emitió tienen que
    // seguir señalando al equipo que los hizo.
    if (registro?.id) {
      await prisma.dispositivoTaquilla.update({
        where: { id: registro.id },
        data: { revocado: true, fechaActualizacion: getFechaUTC6() },
      });
    }

    // Nada de la prueba puede quedar contando en ninguna caja.
    const vivos = await prisma.ticket.count({
      where: { idAperturaCaja: { in: cajasCreadas }, anulado: false },
    });
    expect(vivos).toBe(0);

    await prisma.$disconnect();
  });

  /** Un folio de esta taquilla, con el formato exacto que valida el servidor. */
  const folioNuevo = () => {
    siguiente += 1;
    const correlativo = String(900000 + siguiente).padStart(6, '0');
    return `TCK-${registro.serie}-${anioDeNegocio()}-${correlativo}`;
  };

  const venta = async (extra: any = {}) => {
    const numeroTicket = extra.numeroTicket ?? folioNuevo();
    return {
      idLocal: randomUUID(),
      numeroTicket,
      firma: await taquilla.firmar(numeroTicket),
      fechaEmision: new Date(Date.now() - 60_000).toISOString(),
      montoCobrado: '20.00',
      nombreGrupo: `${ETIQUETA} grupo`,
      idAtraccion: catalogo.atraccion.id,
      idOrigen: catalogo.origen.id,
      idTipoRecorrido: catalogo.recorrido.id,
      cantidades: [{ idTipoVisitante: catalogo.tipoVisitante.id, cantidad: 1 }],
      idOpcionPago: EFECTIVO,
      ...extra,
    };
  };

  const subir = (ventas: any[]) =>
    offline.emitirOffline(
      { dispositivo: ID_DISPOSITIVO, idAperturaCaja: idCajaPrueba, ventas } as any,
      EJECUTOR,
    );

  describe('habilitar la taquilla', () => {
    it('entrega serie propia, correlativo en cero y la caja del turno', () => {
      expect(registro.serie).toMatch(/^D[0-9]{2,}$/);
      expect(registro.ultimoCorrelativo).toBe(0);
      expect(registro.revocado).toBe(false);
      // En un solo viaje: el equipo no puede depender de una segunda llamada que
      // quizá falle cuando ya no haya red.
      expect(registro.caja.id).toBe(idCajaPrueba);
    });

    it('guardó la llave pública tal cual, para poder verificar las firmas', async () => {
      const fila = await prisma.dispositivoTaquilla.findUnique({
        where: { id: registro.id },
      });

      expect(fila!.llavePublica).toBe(taquilla.llavePublica);
    });
  });

  /**
   * El caso que no existía y que dejó pasar el bug: la venta completa, hasta que el
   * ticket está escrito en SQL Server.
   */
  describe('subir una venta firmada', () => {
    it('escribe el ticket de verdad y lo deja en la caja del turno', async () => {
      const v = await venta();

      const res = await subir([v]);

      expect(res.procesadas).toBe(1);
      expect(res.resultados[0]).toMatchObject({ idLocal: v.idLocal, estado: 'CREADO' });

      const fila = await prisma.ticket.findUnique({
        where: { numeroTicket: v.numeroTicket },
      });

      expect(fila).not.toBeNull();
      expect(fila!.idAperturaCaja).toBe(idCajaPrueba);
      expect(fila!.anulado).toBe(false);
    });

    it('deja constancia de qué taquilla lo emitió', async () => {
      const v = await venta();
      await subir([v]);

      const fila = await prisma.ticket.findUnique({
        where: { numeroTicket: v.numeroTicket },
      });

      expect(fila!.idDispositivoTaquilla).toBe(registro.id);
      // La fecha de la venta sin conexión se conserva aparte de la de sincronización.
      expect(fila!.fechaEmisionOffline).not.toBeNull();
    });

    /**
     * El contador sube y los folios rendidos también. La resta entre ambos es lo que
     * delata después un cobro que nunca se rindió.
     */
    it('avanza el correlativo de la taquilla y cuenta el folio como rendido', async () => {
      const antes = await prisma.dispositivoTaquilla.findUnique({
        where: { id: registro.id },
      });

      await subir([await venta()]);

      const despues = await prisma.dispositivoTaquilla.findUnique({
        where: { id: registro.id },
      });

      expect(despues!.ultimoCorrelativo).toBeGreaterThan(antes!.ultimoCorrelativo);
      expect(despues!.foliosRendidos).toBe(antes!.foliosRendidos + 1);
    });

    it('la venta suma al arqueo de su caja', async () => {
      const antes = await cajas.arqueo(idCajaPrueba);

      await subir([await venta({ montoCobrado: '20.00' })]);

      const despues = await cajas.arqueo(idCajaPrueba);

      const delta =
        Number(despues.ventasEfectivo) - Number(antes.ventasEfectivo);
      expect(delta).toBeCloseTo(20, 2);
    });
  });

  describe('el pase firmado por la taquilla sirve en la entrada', () => {
    it('valida y queda marcado como usado', async () => {
      const v = await venta();
      await subir([v]);

      const res = await ticketsService.validar(
        { numeroTicket: v.numeroTicket, firma: v.firma } as any,
        EJECUTOR,
      );

      expect(res.valido).toBe(true);

      const fila = await prisma.ticket.findUnique({
        where: { numeroTicket: v.numeroTicket },
      });
      expect(fila!.fechaUso).not.toBeNull();
    });

    /**
     * El folio dice de qué taquilla salió, así que mandar `dispositivo` aparte es
     * redundante: el servidor lo deriva de la serie. Que fuera obligatorio costó
     * caro —el sellado del uso lo omitía y el rechazo parecía un pase inválido—.
     */
    it('no hace falta declarar el dispositivo: sale de la serie del folio', async () => {
      const v = await venta();
      await subir([v]);

      const res = await ticketsService.validar(
        { numeroTicket: v.numeroTicket, firma: v.firma } as any,
        EJECUTOR,
      );

      expect(res.valido).toBe(true);
    });

    it('un segundo paso con el mismo pase se rechaza', async () => {
      const v = await venta();
      await subir([v]);
      await ticketsService.validar(
        { numeroTicket: v.numeroTicket, firma: v.firma } as any,
        EJECUTOR,
      );

      await expect(
        ticketsService.validar(
          { numeroTicket: v.numeroTicket, firma: v.firma } as any,
          EJECUTOR,
        ),
      ).rejects.toThrow();
    });
  });

  describe('reglas que el servidor aplica al subir', () => {
    /**
     * Sin tabla de folios reservados, lo único que impide que un folio respalde dos
     * cobros es el `@unique` de `numeroTicket`. Eso solo se puede comprobar contra
     * SQL Server: es el motor el que lo garantiza, no el código.
     */
    it('el mismo folio no puede respaldar dos ventas', async () => {
      const v = await venta();
      await subir([v]);

      const repetida = await venta({ numeroTicket: v.numeroTicket });
      const res = await subir([repetida]);

      expect(res.procesadas).toBe(0);
      expect(res.resultados[0].codigo).toBe('FOLIO_YA_EMITIDO');
    });

    it('reintentar la misma venta no crea un segundo ticket', async () => {
      const v = await venta();
      await subir([v]);

      const res = await subir([v]);

      expect(res.resultados[0].estado).toBe('DUPLICADO_IGNORADO');

      const cuantos = await prisma.ticket.count({
        where: { numeroTicket: v.numeroTicket },
      });
      expect(cuantos).toBe(1);
    });

    it('una firma que no es de esta taquilla se rechaza', async () => {
      const otra = await crearTaquillaLocal();
      const numeroTicket = folioNuevo();
      const v = await venta({
        numeroTicket,
        firma: await otra.firmar(numeroTicket),
      });

      const res = await subir([v]);

      expect(res.resultados[0].codigo).toBe('FIRMA_INVALIDA');
      const fila = await prisma.ticket.findUnique({ where: { numeroTicket } });
      expect(fila).toBeNull();
    });

    it('sin pasarela no hay tarjeta: solo efectivo', async () => {
      const res = await subir([await venta({ idOpcionPago: TARJETA })]);

      expect(res.resultados[0].codigo).toBe('PAGO_NO_EFECTIVO');
    });

    /**
     * Una venta mala no puede tumbar a las demás: son dinero ya cobrado. El resultado
     * va por ítem justamente para eso.
     */
    it('una venta rechazada no frena a las otras del mismo envío', async () => {
      const buena1 = await venta();
      const mala = await venta({ idOpcionPago: TARJETA });
      const buena2 = await venta();

      const res = await subir([buena1, mala, buena2]);

      expect(res.procesadas).toBe(2);
      expect(res.resultados.map((r: any) => r.estado)).toEqual([
        'CREADO',
        'RECHAZADO',
        'CREADO',
      ]);
    });

    it('un reloj adelantado no manda la venta al futuro', async () => {
      const v = await venta({
        fechaEmision: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      });

      await subir([v]);

      const fila = await prisma.ticket.findUnique({
        where: { numeroTicket: v.numeroTicket },
      });

      // La columna guarda reloj de pared, así que se compara contra ese mismo reloj.
      expect(fila!.fechaEmisionOffline!.getTime()).toBeLessThanOrEqual(
        getFechaUTC6().getTime() + 60_000,
      );
    });

    /**
     * Retrodatar abarata la tarifa: si los precios subieron, una venta fechada antes
     * resuelve un esperado menor y la diferencia deja de contar como discrepancia.
     * El piso es la apertura de la caja, que es de hoy.
     */
    it('una venta fechada antes de abrir la caja se acota a la apertura', async () => {
      const apertura = await prisma.aperturaCaja.findUnique({
        where: { id: idCajaPrueba },
      });

      const v = await venta({
        fechaEmision: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      });

      await subir([v]);

      const fila = await prisma.ticket.findUnique({
        where: { numeroTicket: v.numeroTicket },
      });

      expect(fila!.fechaEmisionOffline!.getTime()).toBeGreaterThanOrEqual(
        apertura!.fechaCreacion.getTime() - 1000,
      );
    });

    it('un cobro de menos se registra igual y deja la diferencia anotada', async () => {
      const v = await venta({ montoCobrado: '5.00' });

      const res = await subir([v]);

      expect(res.resultados[0].estado).toBe('CREADO');
      expect(res.resultados[0].discrepancia).not.toBeNull();

      const fila = await prisma.ticket.findUnique({
        where: { numeroTicket: v.numeroTicket },
      });
      expect(fila!.montoRecalculado).not.toBeNull();
    });
  });

  describe('la bitácora deja rastro de cada sincronización', () => {
    it('registra la emisión con su módulo y acción', async () => {
      const v = await venta();
      await subir([v]);

      const registros = await prisma.bitacora.findMany({
        where: { accion: 'EMITIR_TICKET_OFFLINE' },
        orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
        take: 5,
      });

      const mio = registros.find((r) => r.descripcion.includes(v.numeroTicket));
      expect(mio).toBeDefined();
    });
  });
});
