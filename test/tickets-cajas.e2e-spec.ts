// La suite dispara ~90 peticiones en segundos; sin subir el techo chocaría con el
// límite por IP y los fallos serían del throttler, no del código bajo prueba.
// Debe ejecutarse antes de importar AppModule, que lee la configuración al inicializarse.
process.env.THROTTLE_LIMITE = '100000';

import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * e2e del circuito de dinero contra la BD de desarrollo.
 *
 * Reglas de higiene (skill qa-produccion):
 *  - Nunca borra registros: todo se da de baja lógicamente.
 *  - Aborta si ya hay una caja abierta real, para no interferir con la operación.
 *  - Deja el estado de caja como lo encontró.
 */
const PREFIJO = 'QA-TEST-';
const ID_USUARIO_CON_PERMISOS = 3; // Manuel Castellanos
const ID_USUARIO_SIN_PERMISOS = 5; // Javier Zepeda: solo Usuarios.Ver y Acciones.Ver

const PAYLOADS_XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
];

const PAYLOADS_SQLI = ["' OR 1=1--", "'; DROP TABLE Usuario;--", '1 UNION SELECT null--'];

describe('Circuito de dinero: Cajas + Tickets + Gastos (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let tokenOk: string;
  let tokenSinPermiso: string;

  // Estado compartido del flujo
  let idCaja: number;
  let catalogos: any;
  const ticketsCreados: number[] = [];
  const gastosCreados: number[] = [];
  let tipoGastoId: number;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = modulo.createNestApplication();
    // Debe replicar src/main.ts o los 400 esperados no se producen.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);

    // Tokens firmados con el secreto de la app: el guard solo exige { sub }.
    const jwt = app.get(JwtService);
    tokenOk = await jwt.signAsync({ sub: ID_USUARIO_CON_PERMISOS });
    tokenSinPermiso = await jwt.signAsync({ sub: ID_USUARIO_SIN_PERMISOS });

    const abierta = await prisma.aperturaCaja.findFirst({
      where: { anulado: false, estado: { nombre: 'Abierta' } },
    });
    if (abierta) {
      throw new Error(
        `Hay una caja abierta real (ID ${abierta.id}). Se aborta para no alterar la operación.`,
      );
    }
  }, 60000);

  afterAll(async () => {
    // Limpieza solo por baja lógica, y en orden: anular tickets exige caja abierta.
    try {
      const caja = idCaja
        ? await prisma.aperturaCaja.findUnique({
            where: { id: idCaja },
            include: { estado: true },
          })
        : null;

      if (caja && !caja.anulado && caja.estado.nombre === 'Abierta') {
        for (const id of ticketsCreados) {
          await request(http).delete(`/tickets/${id}`).set(auth(tokenOk));
        }
        for (const id of gastosCreados) {
          await request(http).delete(`/gastos/${id}`).set(auth(tokenOk));
        }
        await request(http).delete(`/cajas/${idCaja}`).set(auth(tokenOk));
      }
    } finally {
      await app.close();
    }
  }, 60000);

  describe('Fase 1 — protección de rutas', () => {
    const rutas = [
      ['get', '/cajas'],
      ['get', '/gastos'],
      ['get', '/tickets'],
      ['get', '/tickets/catalogos'],
      ['get', '/tarifas'],
    ] as const;

    it.each(rutas)('%s %s sin token devuelve 401', async (metodo, ruta) => {
      await request(http)[metodo](ruta).expect(401);
    });

    it.each(rutas)('%s %s con usuario sin permiso devuelve 403', async (metodo, ruta) => {
      await request(http)[metodo](ruta).set(auth(tokenSinPermiso)).expect(403);
    });

    it.each(rutas)('%s %s con permiso devuelve 200', async (metodo, ruta) => {
      await request(http)[metodo](ruta).set(auth(tokenOk)).expect(200);
    });

    it('rechaza un token con firma alterada', async () => {
      await request(http).get('/cajas').set(auth(tokenOk + 'x')).expect(401);
    });

    // Regresión: devolvía 200 con cuerpo vacío y sin content-type cuando no había
    // caja abierta, y `response.json()` reventaba con "Unexpected end of JSON input".
    it('sin caja abierta responde JSON válido, nunca un cuerpo vacío', async () => {
      const res = await request(http).get('/cajas/actual').set(auth(tokenOk)).expect(200);

      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.text.length).toBeGreaterThan(0);
      expect(() => JSON.parse(res.text)).not.toThrow();
      expect(res.body.hayCajaAbierta).toBe(false);
      expect(res.body.caja).toBeNull();
    });

    it('el menú no exige permisos (solo sesión)', async () => {
      const res = await request(http)
        .get('/modulos/mis-modulos')
        .set(auth(tokenSinPermiso))
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('Fase 2 — catálogos de emisión', () => {
    it('devuelve todos los parámetros del formulario en una llamada', async () => {
      const res = await request(http).get('/tickets/catalogos').set(auth(tokenOk)).expect(200);
      catalogos = res.body;

      expect(catalogos.atracciones.length).toBeGreaterThan(0);
      expect(catalogos.origenes.length).toBe(2);
      expect(catalogos.paises.length).toBeGreaterThan(100);
      expect(catalogos.tiposVisitante.length).toBe(4);
      expect(catalogos.opcionesPago.length).toBeGreaterThan(0);
      expect(catalogos.tarifas.length).toBeGreaterThan(0);
      expect(catalogos.precioTicketGuia).not.toBeNull();
    });

    it('expone efectivo marcado con esEfectivo (base del arqueo)', () => {
      const efectivo = catalogos.opcionesPago.find((o: any) => o.esEfectivo === true);
      expect(efectivo).toBeDefined();
    });
  });

  describe('Fase 3 — flujo completo del dinero', () => {
    const buscarAtraccion = () => catalogos.atracciones[0].id;
    const buscarOrigen = (codigo: string) =>
      catalogos.origenes.find((o: any) => o.codigo === codigo).id;
    const buscarTipo = (codigo: string) =>
      catalogos.tiposVisitante.find((t: any) => t.codigo === codigo).id;
    const efectivoId = () => catalogos.opcionesPago.find((o: any) => o.esEfectivo).id;

    it('no permite emitir sin caja abierta', async () => {
      const res = await request(http)
        .post('/tickets/emitir')
        .set(auth(tokenOk))
        .send({
          nombreGrupo: `${PREFIJO}sin caja`,
          idAtraccion: buscarAtraccion(),
          idOrigen: buscarOrigen('nacional'),
          idTipoRecorrido: catalogos.tiposRecorrido[0].id,
          cantidades: [{ idTipoVisitante: buscarTipo('adulto'), cantidad: 1 }],
          idOpcionPago: efectivoId(),
        });

      expect(res.status).toBe(400);
    });

    it('abre la caja', async () => {
      const res = await request(http)
        .post('/cajas/apertura')
        .set(auth(tokenOk))
        .send({ montoInicial: 500, observaciones: `${PREFIJO}apertura` })
        .expect(201);

      idCaja = res.body.id;
      expect(res.body.estado.nombre).toBe('Abierta');
    });

    it('con caja abierta la reporta en el mismo envoltorio', async () => {
      const res = await request(http).get('/cajas/actual').set(auth(tokenOk)).expect(200);

      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.hayCajaAbierta).toBe(true);
      expect(res.body.caja.id).toBe(idCaja);
      expect(res.body.caja.estado.nombre).toBe('Abierta');
    });

    it('impide una segunda caja abierta (409)', async () => {
      await request(http)
        .post('/cajas/apertura')
        .set(auth(tokenOk))
        .send({ montoInicial: 100 })
        .expect(409);
    });

    it('emite un ticket nacional en efectivo por Q70 (2 adultos + 3 niños)', async () => {
      const res = await request(http)
        .post('/tickets/emitir')
        .set(auth(tokenOk))
        .send({
          nombreGrupo: `${PREFIJO}Familia`,
          idAtraccion: buscarAtraccion(),
          idOrigen: buscarOrigen('nacional'),
          idTipoRecorrido: catalogos.tiposRecorrido[0].id,
          cantidades: [
            { idTipoVisitante: buscarTipo('adulto'), cantidad: 2 },
            { idTipoVisitante: buscarTipo('nino'), cantidad: 3 },
          ],
          idOpcionPago: efectivoId(),
        })
        .expect(201);

      expect(Number(res.body.montoVisitantes)).toBe(70);
      expect(res.body.tickets).toHaveLength(1);
      expect(res.body.tickets[0].numeroTicket).toMatch(/^TCK-\d{4}-\d{6}$/);
      ticketsCreados.push(res.body.tickets[0].id);
    });

    it('emite 2 tickets cuando el guía no tiene carnet', async () => {
      const res = await request(http)
        .post('/tickets/emitir')
        .set(auth(tokenOk))
        .send({
          nombreGrupo: `${PREFIJO}Con guia`,
          idAtraccion: buscarAtraccion(),
          idOrigen: buscarOrigen('nacional'),
          idTipoRecorrido: catalogos.tiposRecorrido[0].id,
          cantidades: [{ idTipoVisitante: buscarTipo('adulto'), cantidad: 1 }],
          idOpcionPago: efectivoId(),
          guia: { modo: 'nuevo', nombre: `${PREFIJO}Guia`, tieneCarnet: false },
        })
        .expect(201);

      expect(res.body.tickets).toHaveLength(2);
      expect(res.body.tickets[1].tipoTicket).toBe('GUIA');
      expect(Number(res.body.montoGuia)).toBe(15);
      expect(Number(res.body.montoTotalGeneral)).toBe(35); // 20 + 15
      res.body.tickets.forEach((t: any) => ticketsCreados.push(t.id));
    });

    it('exige país cuando el origen es extranjero (400)', async () => {
      await request(http)
        .post('/tickets/emitir')
        .set(auth(tokenOk))
        .send({
          nombreGrupo: `${PREFIJO}Extranjero`,
          idAtraccion: buscarAtraccion(),
          idOrigen: buscarOrigen('extranjero'),
          idTipoRecorrido: catalogos.tiposRecorrido[0].id,
          cantidades: [{ idTipoVisitante: buscarTipo('adulto'), cantidad: 1 }],
          idOpcionPago: efectivoId(),
        })
        .expect(400);
    });

    it('rechaza centro educativo para extranjeros (400)', async () => {
      await request(http)
        .post('/tickets/emitir')
        .set(auth(tokenOk))
        .send({
          nombreGrupo: `${PREFIJO}CentroEdu`,
          idAtraccion: buscarAtraccion(),
          idOrigen: buscarOrigen('extranjero'),
          idPais: catalogos.paises[0].id,
          idTipoRecorrido: catalogos.tiposRecorrido[0].id,
          cantidades: [{ idTipoVisitante: buscarTipo('centro_educativo'), cantidad: 1 }],
          idOpcionPago: efectivoId(),
        })
        .expect(400);
    });

    it('cobra Q0 por el niño menor de 7 años', async () => {
      const res = await request(http)
        .post('/tickets/emitir')
        .set(auth(tokenOk))
        .send({
          nombreGrupo: `${PREFIJO}Menores`,
          idAtraccion: buscarAtraccion(),
          idOrigen: buscarOrigen('nacional'),
          idTipoRecorrido: catalogos.tiposRecorrido[0].id,
          cantidades: [{ idTipoVisitante: buscarTipo('nino_menor'), cantidad: 4 }],
          idOpcionPago: efectivoId(),
        })
        .expect(201);

      expect(Number(res.body.montoVisitantes)).toBe(0);
      expect(res.body.tickets[0].cantidadPersonas).toBe(4);
      ticketsCreados.push(res.body.tickets[0].id);
    });

    it('EL ARQUEO SUMA LAS VENTAS EN EFECTIVO', async () => {
      const res = await request(http)
        .get(`/cajas/${idCaja}/arqueo`)
        .set(auth(tokenOk))
        .expect(200);

      // 70 (familia) + 20 (con guía) + 15 (guía) + 0 (menores) = 105
      expect(res.body.ventasEfectivo).toBe(105);
      expect(res.body.montoInicial).toBe(500);
      expect(res.body.totalGastos).toBe(0);
      expect(res.body.montoEsperado).toBe(605);
    });

    it('registra un gasto y el arqueo lo descuenta', async () => {
      const tg = await request(http)
        .post('/tipos-gasto')
        .set(auth(tokenOk))
        .send({ nombre: `${PREFIJO}Insumos ${Date.now()}` })
        .expect(201);
      tipoGastoId = tg.body.id;

      const gasto = await request(http)
        .post('/gastos')
        .set(auth(tokenOk))
        .send({ idTipoGasto: tipoGastoId, descripcion: `${PREFIJO}compra`, monto: 55 })
        .expect(201);
      gastosCreados.push(gasto.body.id);

      expect(gasto.body.idAperturaCaja).toBe(idCaja);
      expect(gasto.body.idUsuario).toBe(ID_USUARIO_CON_PERMISOS);

      const arqueo = await request(http)
        .get(`/cajas/${idCaja}/arqueo`)
        .set(auth(tokenOk))
        .expect(200);

      expect(arqueo.body.totalGastos).toBe(55);
      expect(arqueo.body.montoEsperado).toBe(550); // 500 + 105 - 55
    });

    it('anular un ticket lo saca del arqueo', async () => {
      const idMenores = ticketsCreados[ticketsCreados.length - 1];
      await request(http).delete(`/tickets/${idMenores}`).set(auth(tokenOk)).expect(200);

      // El ticket de menores costaba 0, así que el esperado no cambia.
      const arqueo = await request(http)
        .get(`/cajas/${idCaja}/arqueo`)
        .set(auth(tokenOk))
        .expect(200);
      expect(arqueo.body.montoEsperado).toBe(550);

      // Y anularlo dos veces se rechaza.
      await request(http).delete(`/tickets/${idMenores}`).set(auth(tokenOk)).expect(400);
      ticketsCreados.pop();
    });

    it('el historial agrega métricas en el servidor', async () => {
      const res = await request(http)
        .get('/tickets?limite=10&pagina=1')
        .set(auth(tokenOk))
        .expect(200);

      expect(res.body).toHaveProperty('datos');
      expect(res.body).toHaveProperty('total');
      expect(res.body.metricas.totalTickets).toBeGreaterThan(0);
      expect(Number(res.body.metricas.montoRecaudado)).toBeGreaterThan(0);
    });
  });

  describe('Fase 4 — control de acceso por QR', () => {
    let numeroTicket: string;
    let firma: string;

    it('obtiene el QR del ticket emitido', async () => {
      const res = await request(http)
        .get(`/tickets/${ticketsCreados[0]}`)
        .set(auth(tokenOk))
        .expect(200);

      const qr = JSON.parse(res.body.qr);
      numeroTicket = qr.numeroTicket;
      firma = qr.firma;
      expect(numeroTicket).toBeDefined();
      expect(firma).toHaveLength(64); // HMAC-SHA256 hex
    });

    it('rechaza una firma alterada (401)', async () => {
      await request(http)
        .post('/tickets/validar')
        .set(auth(tokenOk))
        .send({ numeroTicket, firma: 'a'.repeat(64) })
        .expect(401);
    });

    it('rechaza un folio inexistente con firma válida para otro folio (401)', async () => {
      await request(http)
        .post('/tickets/validar')
        .set(auth(tokenOk))
        .send({ numeroTicket: 'TCK-1999-000001', firma })
        .expect(401);
    });

    it('acepta el primer uso (200)', async () => {
      const res = await request(http)
        .post('/tickets/validar')
        .set(auth(tokenOk))
        .send({ numeroTicket, firma })
        .expect(200);

      expect(res.body.valido).toBe(true);
    });

    it('rechaza el reingreso (409)', async () => {
      await request(http)
        .post('/tickets/validar')
        .set(auth(tokenOk))
        .send({ numeroTicket, firma })
        .expect(409);
    });
  });

  describe('Fase 5 — seguridad', () => {
    it.each(PAYLOADS_SQLI)('trata %s como texto literal, sin 500', async (payload) => {
      const res = await request(http)
        .post('/tipos-gasto')
        .set(auth(tokenOk))
        .send({ nombre: `${PREFIJO}${payload}` });

      expect([201, 400, 409]).toContain(res.status);
      if (res.status === 201) {
        expect(res.body.nombre).toBe(`${PREFIJO}${payload}`);
      }
    });

    it('la BD sigue intacta tras los payloads de inyección', async () => {
      expect(await prisma.usuario.count()).toBeGreaterThan(0);
    });

    it.each(PAYLOADS_XSS)('devuelve %s como JSON, no HTML', async (payload) => {
      const res = await request(http)
        .post('/tipos-gasto')
        .set(auth(tokenOk))
        .send({ nombre: `${PREFIJO}${payload}` });

      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.status).not.toBe(500);
    });

    it('rechaza campos no declarados en el DTO (400)', async () => {
      await request(http)
        .post('/cajas/apertura')
        .set(auth(tokenOk))
        .send({ montoInicial: 10, campoInventado: 'x', id: 999 })
        .expect(400);
    });

    it('rechaza montos negativos (400)', async () => {
      await request(http)
        .post('/gastos')
        .set(auth(tokenOk))
        .send({ idTipoGasto: tipoGastoId, descripcion: 'neg', monto: -50 })
        .expect(400);
    });

    it('el cliente no puede imponer el precio del ticket', async () => {
      const res = await request(http)
        .post('/tickets/emitir')
        .set(auth(tokenOk))
        .send({
          nombreGrupo: `${PREFIJO}precio`,
          idAtraccion: catalogos.atracciones[0].id,
          idOrigen: catalogos.origenes.find((o: any) => o.codigo === 'nacional').id,
          idTipoRecorrido: catalogos.tiposRecorrido[0].id,
          cantidades: [
            { idTipoVisitante: catalogos.tiposVisitante.find((t: any) => t.codigo === 'adulto').id, cantidad: 1 },
          ],
          idOpcionPago: catalogos.opcionesPago.find((o: any) => o.esEfectivo).id,
          montoTotal: 1,
          precio: 1,
        });

      // forbidNonWhitelisted debe rechazar los campos de precio inyectados.
      expect(res.status).toBe(400);
    });

    it('ParseIntPipe rechaza un id no numérico (400)', async () => {
      await request(http).get('/tickets/abc').set(auth(tokenOk)).expect(400);
    });

    it('devuelve 404 para un id inexistente', async () => {
      await request(http).get('/tickets/99999999').set(auth(tokenOk)).expect(404);
    });

    // La validación rechaza módulos no asignables Y módulos anulados: ambos
    // producirían permisos que el guard nunca honraría.
    it('no permite asignar permisos de un módulo anulado (400)', async () => {
      const maAnulado = await prisma.moduloAccion.findFirst({
        where: { modulo: { anulado: true } },
      });
      expect(maAnulado).not.toBeNull();

      const res = await request(http)
        .post(`/usuarios/${ID_USUARIO_SIN_PERMISOS}/permisos`)
        .set(auth(tokenOk))
        .send({ idsModuloAccion: [maAnulado!.id] })
        .expect(400);

      expect(res.body.message).toMatch(/no asignables|anulados/i);
    });

    it('la lista de módulo-acciones solo trae lo asignable', async () => {
      const res = await request(http).get('/modulo-acciones').set(auth(tokenOk)).expect(200);

      expect(res.body.length).toBeGreaterThan(0);
      for (const ma of res.body) {
        expect(ma.modulo.anulado).toBe(false);
        expect(ma.modulo.esAsignable).toBe(true);
      }
    });
  });

  describe('Fase 6 — cierre y restauración del estado', () => {
    it('cierra la caja calculando la diferencia', async () => {
      // Anula lo creado antes de cerrar: después del cierre ya no se puede.
      for (const id of ticketsCreados) {
        await request(http).delete(`/tickets/${id}`).set(auth(tokenOk));
      }
      for (const id of gastosCreados) {
        await request(http).delete(`/gastos/${id}`).set(auth(tokenOk));
      }

      const arqueo = await request(http)
        .get(`/cajas/${idCaja}/arqueo`)
        .set(auth(tokenOk))
        .expect(200);

      // Todo anulado: vuelve al monto inicial.
      expect(arqueo.body.ventasEfectivo).toBe(0);
      expect(arqueo.body.totalGastos).toBe(0);
      expect(arqueo.body.montoEsperado).toBe(500);

      const cierre = await request(http)
        .post(`/cajas/${idCaja}/cierre`)
        .set(auth(tokenOk))
        .send({ montoContado: 490, observaciones: `${PREFIJO}cierre` })
        .expect(201);

      expect(Number(cierre.body.cierre.diferencia)).toBe(-10); // faltante
      ticketsCreados.length = 0;
      gastosCreados.length = 0;
    });

    it('impide un segundo cierre (400)', async () => {
      await request(http)
        .post(`/cajas/${idCaja}/cierre`)
        .set(auth(tokenOk))
        .send({ montoContado: 100 })
        .expect(400);
    });

    it('impide anular la apertura de una caja cerrada (400)', async () => {
      await request(http).delete(`/cajas/${idCaja}`).set(auth(tokenOk)).expect(400);
    });

    it('no permite registrar gastos con la caja cerrada (400)', async () => {
      await request(http)
        .post('/gastos')
        .set(auth(tokenOk))
        .send({ idTipoGasto: tipoGastoId, descripcion: 'tarde', monto: 10 })
        .expect(400);
    });

    it('deja el sistema sin caja abierta', async () => {
      const abierta = await prisma.aperturaCaja.findFirst({
        where: { anulado: false, estado: { nombre: 'Abierta' } },
      });
      expect(abierta).toBeNull();
    });
  });
});
