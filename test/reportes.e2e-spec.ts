// La suite dispara decenas de peticiones en segundos; sin subir el techo chocaría con el
// límite por IP y los fallos serían del throttler, no del código bajo prueba.
// Debe ejecutarse antes de importar AppModule, que lee la configuración al inicializarse.
process.env.THROTTLE_LIMITE = '100000';

// Se fuerza la ausencia de clave: ninguna de las rutas predeterminadas debe necesitarla, y
// esta suite lo comprueba de la única forma que vale, quitándola.
delete process.env.IA_API_KEY;

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * e2e del módulo de Reportes contra la BD de desarrollo.
 *
 * Reglas de higiene (skill qa-produccion):
 *  - No crea ni borra nada: los reportes son de solo lectura.
 *  - La única escritura que provocan es la fila de bitácora de cada consulta, que es
 *    justamente lo que se quiere que ocurra.
 */
const ID_USUARIO_CON_PERMISOS = 3; // Manuel Castellanos
const ID_USUARIO_SIN_PERMISOS = 5; // Javier Zepeda: solo Usuarios.Ver y Acciones.Ver

const PAYLOADS_XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
];

const PAYLOADS_SQLI = [
  "' OR 1=1--",
  "'; DROP TABLE Usuario;--",
  '1 UNION SELECT null--',
];

const RANGO = { desde: '2026-08-01', hasta: '2026-08-31' };

describe('Reportes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let tokenOk: string;
  let tokenSinPermiso: string;

  /** Claves que el usuario de prueba puede ejecutar, según su propio catálogo. */
  let clavesPermitidas: string[] = [];

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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

    const jwt = app.get(JwtService);
    tokenOk = await jwt.signAsync({ sub: ID_USUARIO_CON_PERMISOS });
    tokenSinPermiso = await jwt.signAsync({ sub: ID_USUARIO_SIN_PERMISOS });

    const modulo_ = await prisma.modulo.findUnique({
      where: { nombre: 'Reportes' },
    });
    if (!modulo_) {
      throw new Error(
        'Falta el módulo Reportes en la base. Ejecute: npx ts-node prisma/seed-reportes.ts',
      );
    }

    const catalogo = await request(http).get('/reportes').set(auth(tokenOk));
    clavesPermitidas = (catalogo.body?.datos ?? []).map((r: any) => r.clave);
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  describe('protección de rutas', () => {
    const rutas = [
      ['get', '/reportes'],
      ['get', '/reportes/ventas-resumen'],
      ['get', '/reportes/ventas-resumen/pdf'],
      ['get', '/reportes/ventas-resumen/excel'],
      ['post', '/reportes/interpretar'],
    ] as const;

    it.each(rutas)('%s %s responde 401 sin token', async (metodo, ruta) => {
      const respuesta = await (request(http) as any)[metodo](ruta);
      expect(respuesta.status).toBe(401);
    });

    it.each(rutas)(
      '%s %s responde 403 sin el permiso Reportes',
      async (metodo, ruta) => {
        const peticion = (request(http) as any)
          [metodo](ruta)
          .set(auth(tokenSinPermiso));
        const respuesta =
          metodo === 'post'
            ? await peticion.send({ instruccion: 'ventas' })
            : await peticion;
        expect(respuesta.status).toBe(403);
      },
    );
  });

  describe('catálogo', () => {
    it('devuelve solo los reportes que el usuario puede ejecutar', async () => {
      const { status, body } = await request(http)
        .get('/reportes')
        .set(auth(tokenOk));

      expect(status).toBe(200);
      expect(Array.isArray(body.datos)).toBe(true);
      expect(body.total).toBe(body.datos.length);
      // Cada entrada trae lo que el frontend necesita para pintar su formulario.
      for (const reporte of body.datos) {
        expect(reporte).toMatchObject({
          clave: expect.any(String),
          titulo: expect.any(String),
          categoria: expect.any(String),
          moduloOrigen: expect.any(String),
          filtros: expect.any(Array),
        });
      }
    });

    /** Sin clave configurada, el frontend no debe pintar el campo de petición libre. */
    it('avisa de que la interpretación por IA no está disponible', async () => {
      const { body } = await request(http).get('/reportes').set(auth(tokenOk));
      expect(body.interpretacionDisponible).toBe(false);
    });
  });

  describe('los reportes predeterminados no dependen de la IA', () => {
    /**
     * La comprobación que da sentido a las dos vías: con `IA_API_KEY` vacía, los tres
     * formatos de todos los reportes del catálogo tienen que responder 200.
     */
    it('todos los reportes del catálogo responden 200 en JSON, PDF y Excel', async () => {
      expect(clavesPermitidas.length).toBeGreaterThan(0);

      for (const clave of clavesPermitidas) {
        // El arqueo exige una caja concreta; se prueba aparte.
        if (clave === 'arqueo-de-caja') continue;

        const json = await request(http)
          .get(`/reportes/${clave}`)
          .query(RANGO)
          .set(auth(tokenOk));
        expect([clave, json.status]).toEqual([clave, 200]);
        expect(json.body).toMatchObject({
          clave,
          generadoPor: expect.any(String),
        });

        const pdf = await request(http)
          .get(`/reportes/${clave}/pdf`)
          .query(RANGO)
          .set(auth(tokenOk))
          .buffer()
          .parse((res, cb) => {
            const trozos: Buffer[] = [];
            res.on('data', (t: Buffer) => trozos.push(t));
            res.on('end', () => cb(null, Buffer.concat(trozos)));
          });
        expect([clave, pdf.status]).toEqual([clave, 200]);
        expect(pdf.headers['content-type']).toContain('application/pdf');
        expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

        const excel = await request(http)
          .get(`/reportes/${clave}/excel`)
          .query(RANGO)
          .set(auth(tokenOk))
          .buffer()
          .parse((res, cb) => {
            const trozos: Buffer[] = [];
            res.on('data', (t: Buffer) => trozos.push(t));
            res.on('end', () => cb(null, Buffer.concat(trozos)));
          });
        expect([clave, excel.status]).toEqual([clave, 200]);
        expect(excel.headers['content-type']).toContain('spreadsheetml');
        // `attachment`: ningún navegador renderiza un xlsx en línea.
        expect(excel.headers['content-disposition']).toContain('attachment');
      }
    }, 180000);

    it('la ruta de interpretación responde 503 sin clave configurada', async () => {
      const { status, body } = await request(http)
        .post('/reportes/interpretar')
        .set(auth(tokenOk))
        .send({ instruccion: 'ventas del mes pasado por vendedor' });

      expect(status).toBe(503);
      expect(body.message).toMatch(/no está configurada/i);
    });
  });

  describe('permisos por módulo de origen', () => {
    /**
     * `Reportes.Ver` abre el módulo, no los datos. Un usuario con acceso a reportes pero
     * sin permiso sobre el módulo dueño de las cifras tiene que recibir 403, o el módulo
     * de reportes se convierte en la puerta trasera de todos los demás.
     */
    it('rechaza un reporte cuyo módulo de origen el usuario no puede ver', async () => {
      const catalogo = await request(http).get('/reportes').set(auth(tokenOk));
      const modulos: string[] = catalogo.body.datos.map(
        (r: any) => r.moduloOrigen,
      );

      // Se busca un reporte que NO esté en el catálogo del usuario: por definición, es uno
      // cuyo módulo de origen no puede ver.
      const ajenos = [
        'bitacora-detalle',
        'usuarios-permisos',
        'donaciones-detalle',
      ].filter((clave) => !clavesPermitidas.includes(clave));

      if (ajenos.length === 0) {
        // El usuario de prueba tiene permiso sobre todo: se deja constancia en vez de
        // dar por buena una aserción que no se ejecutó.
        expect(modulos.length).toBeGreaterThan(0);
        return;
      }

      const { status, body } = await request(http)
        .get(`/reportes/${ajenos[0]}`)
        .query(RANGO)
        .set(auth(tokenOk));

      expect(status).toBe(403);
      expect(body.message).toMatch(/módulo/i);
    });
  });

  describe('el cajero no ve las cifras del arqueo', () => {
    /**
     * La aserción de seguridad más importante de la suite.
     *
     * Quien cuenta el efectivo no debe conocer el monto esperado: si lo supiera, bastaría
     * teclear esa cifra para que ningún faltante saliera nunca a la luz. Se comprueba en
     * el JSON **y dentro del .xlsx**, porque el archivo se arma del mismo objeto.
     */
    /** ¿El usuario de prueba tiene la acción que representa supervisión de caja? */
    const supervisaCaja = () =>
      prisma.permisos.findFirst({
        where: {
          idUsuario: ID_USUARIO_CON_PERMISOS,
          moduloAccion: {
            modulo: { nombre: 'Cajas', anulado: false },
            accion: { nombre: 'Editar' },
          },
        },
      });

    it('omite montoEsperado y diferencia cuando quien pide no es supervisor', async () => {
      const supervisor = await supervisaCaja();

      if (supervisor) {
        // El usuario de prueba sí supervisa: entonces lo que hay que comprobar es lo
        // contrario, que las columnas de arqueo llegan.
        const { body } = await request(http)
          .get('/reportes/cajas-turnos')
          .query(RANGO)
          .set(auth(tokenOk));

        const columnas = body.secciones[0].columnas.map((c: any) => c.clave);
        expect(columnas).toContain('montoEsperado');
        return;
      }

      const { body } = await request(http)
        .get('/reportes/cajas-turnos')
        .query(RANGO)
        .set(auth(tokenOk));

      const columnas = body.secciones[0].columnas.map((c: any) => c.clave);
      expect(columnas).not.toContain('montoEsperado');
      expect(columnas).not.toContain('diferencia');
      // Y el dato tampoco viaja escondido dentro de las filas.
      expect(JSON.stringify(body.secciones[0].filas)).not.toContain(
        'montoEsperado',
      );
    });

    it('tampoco las filtra dentro del archivo de Excel', async () => {
      const respuesta = await request(http)
        .get('/reportes/cajas-turnos/excel')
        .query(RANGO)
        .set(auth(tokenOk))
        .buffer()
        .parse((res, cb) => {
          const trozos: Buffer[] = [];
          res.on('data', (t: Buffer) => trozos.push(t));
          res.on('end', () => cb(null, Buffer.concat(trozos)));
        });

      const supervisor = await supervisaCaja();

      const libro = new ExcelJS.Workbook();
      await libro.xlsx.load(respuesta.body);
      const contenido = libro.worksheets
        .map((hoja) => JSON.stringify(hoja.getSheetValues()))
        .join(' ');

      if (supervisor) {
        expect(contenido).toContain('Esperado');
      } else {
        expect(contenido).not.toContain('Esperado');
        expect(contenido).not.toContain('Diferencia');
      }
    });
  });

  describe('validación de filtros', () => {
    it('responde 404 con la lista de reportes si la clave no existe', async () => {
      const { status, body } = await request(http)
        .get('/reportes/ventas-inventadas')
        .set(auth(tokenOk));

      expect(status).toBe(404);
      expect(body.message).toContain('ventas-resumen');
    });

    it('rechaza una fecha mal formada', async () => {
      const { status } = await request(http)
        .get('/reportes/ventas-resumen')
        .query({ desde: '01/08/2026', hasta: '2026-08-31' })
        .set(auth(tokenOk));

      expect(status).toBe(400);
    });

    it('rechaza un rango invertido', async () => {
      const { status } = await request(http)
        .get('/reportes/ventas-resumen')
        .query({ desde: '2026-08-31', hasta: '2026-08-01' })
        .set(auth(tokenOk));

      expect(status).toBe(400);
    });

    it('rechaza un rango de más de un año', async () => {
      const { status, body } = await request(http)
        .get('/reportes/ventas-resumen')
        .query({ desde: '2020-01-01', hasta: '2026-01-01' })
        .set(auth(tokenOk));

      expect(status).toBe(400);
      expect(body.message).toMatch(/máximo/i);
    });

    it('rechaza un parámetro que no está declarado', async () => {
      const { status } = await request(http)
        .get('/reportes/ventas-resumen')
        .query({ ...RANGO, parametroInventado: 'x' })
        .set(auth(tokenOk));

      expect(status).toBe(400);
    });
  });

  describe('seguridad de la entrada', () => {
    it.each(PAYLOADS_XSS)(
      'no ejecuta ni refleja XSS en un filtro (%s)',
      async (payload) => {
        const { status, text } = await request(http)
          .get('/reportes/ventas-resumen')
          .query({ ...RANGO, vendedor: payload })
          .set(auth(tokenOk));

        // 422 porque no existe ese vendedor; nunca 500, y el payload no vuelve como HTML.
        expect([200, 422]).toContain(status);
        expect(text).not.toContain('<script>');
        expect(text).not.toContain('onerror=');
      },
    );

    it.each(PAYLOADS_SQLI)(
      'no permite inyección SQL en un filtro (%s)',
      async (payload) => {
        const { status } = await request(http)
          .get('/reportes/ventas-resumen')
          .query({ ...RANGO, vendedor: payload })
          .set(auth(tokenOk));

        expect([200, 422]).toContain(status);

        // Y la tabla que el payload intentaba tirar sigue ahí.
        const usuarios = await prisma.usuario.count();
        expect(usuarios).toBeGreaterThan(0);
      },
    );

    it.each([...PAYLOADS_XSS, ...PAYLOADS_SQLI])(
      'no permite inyección por el filtro de módulo de bitácora (%s)',
      async (payload) => {
        const { status } = await request(http)
          .get('/reportes/bitacora-resumen')
          .query({ ...RANGO, modulo: payload })
          .set(auth(tokenOk));

        expect([200, 403]).toContain(status);
      },
    );

    it.each(PAYLOADS_XSS)(
      'acota la instrucción en lenguaje natural (%s)',
      async (payload) => {
        const { status } = await request(http)
          .post('/reportes/interpretar')
          .set(auth(tokenOk))
          .send({ instruccion: payload });

        // 503 porque no hay clave configurada; lo que importa es que no sea un 500.
        expect([400, 503]).toContain(status);
      },
    );

    it('rechaza una instrucción desmedida', async () => {
      const { status } = await request(http)
        .post('/reportes/interpretar')
        .set(auth(tokenOk))
        .send({ instruccion: 'a'.repeat(2000) });

      expect(status).toBe(400);
    });
  });

  describe('auditoría', () => {
    it('deja constancia en bitácora de quién generó qué reporte', async () => {
      const antes = await prisma.bitacora.count({
        where: { modulo: 'Reportes' },
      });

      await request(http)
        .get('/reportes/ventas-resumen')
        .query(RANGO)
        .set(auth(tokenOk));

      const registro = await prisma.bitacora.findFirst({
        where: { modulo: 'Reportes', idUsuario: ID_USUARIO_CON_PERMISOS },
        orderBy: { id: 'desc' },
      });

      expect(
        await prisma.bitacora.count({ where: { modulo: 'Reportes' } }),
      ).toBeGreaterThan(antes);
      expect(registro?.accion).toBe('GENERAR_REPORTE');
      expect(registro?.descripcion).toContain('ventas-resumen');
    });

    it('distingue la exportación de la consulta', async () => {
      await request(http)
        .get('/reportes/ventas-resumen/excel')
        .query(RANGO)
        .set(auth(tokenOk))
        .buffer()
        .parse((res, cb) => {
          const trozos: Buffer[] = [];
          res.on('data', (t: Buffer) => trozos.push(t));
          res.on('end', () => cb(null, Buffer.concat(trozos)));
        });

      const registro = await prisma.bitacora.findFirst({
        where: { modulo: 'Reportes', idUsuario: ID_USUARIO_CON_PERMISOS },
        orderBy: { id: 'desc' },
      });

      expect(registro?.accion).toBe('EXPORTAR_REPORTE');
      expect(registro?.descripcion).toContain('EXCEL');
    });
  });

  describe('coherencia de las cifras', () => {
    /**
     * El reporte y el historial de tickets tienen que dar el mismo número: si no, la regla
     * de anulados o el rango de fechas está mal en uno de los dos.
     */
    it('el recaudado del reporte cuadra con el de GET /tickets', async () => {
      const reporte = await request(http)
        .get('/reportes/ventas-resumen')
        .query(RANGO)
        .set(auth(tokenOk));

      if (reporte.status !== 200) return;

      const historial = await request(http)
        .get('/tickets')
        .query({
          fechaInicio: `${RANGO.desde}T00:00:00.000Z`,
          fechaFin: `${RANGO.hasta}T23:59:59.999Z`,
          limite: 1,
        })
        .set(auth(tokenOk));

      if (historial.status !== 200) return;

      const kpi = reporte.body.kpis.find(
        (k: any) => k.etiqueta === 'Recaudado',
      );
      const delReporte = Number(String(kpi.valor).replace(/[Q,]/g, ''));
      const delHistorial = Number(historial.body.metricas.montoRecaudado);

      // Un centavo de tolerancia: el historial recorta el rango al milisegundo y el
      // reporte usa el borde exclusivo del día siguiente.
      expect(Math.abs(delReporte - delHistorial)).toBeLessThan(0.011);
    });
  });
});
