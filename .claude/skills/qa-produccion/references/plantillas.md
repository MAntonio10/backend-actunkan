# Plantillas de prueba

Patrones concretos para este repositorio. Adaptar nombres al módulo bajo prueba.

## 1. Mock de PrismaService (unitarias)

Los servicios envuelven cada escritura en `this.prisma.$transaction(async (tx) => {...})` y llaman al método **estático** `BitacoraService.registrarEnTransaccion(tx, ...)`. El mock debe cubrir ambos.

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from './cajas.service';

// Cliente transaccional simulado: agregar aquí los modelos que use el servicio
const crearTxMock = () => ({
  aperturaCaja: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  cierreCaja: { create: jest.fn(), update: jest.fn() },
  estadoCaja: { findFirst: jest.fn() },
  gastos: { aggregate: jest.fn() },
  ticketPago: { aggregate: jest.fn() },
  usuario: { findUnique: jest.fn() },
  bitacora: { create: jest.fn() },
});

describe('CajasService', () => {
  let service: CajasService;
  let tx: ReturnType<typeof crearTxMock>;
  let prisma: any;

  beforeEach(async () => {
    tx = crearTxMock();
    prisma = {
      // $transaction ejecuta el callback con el tx simulado
      $transaction: jest.fn((cb: any) => cb(tx)),
      aperturaCaja: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
      gastos: { aggregate: jest.fn() },
      ticketPago: { aggregate: jest.fn() },
    };

    // La bitácora es estática: espiarla en lugar de simular tx.bitacora
    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [CajasService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = modulo.get<CajasService>(CajasService);
  });

  afterEach(() => jest.restoreAllMocks());
});
```

## 2. Casos unitarios obligatorios

```ts
it('rechaza abrir una segunda caja si ya hay una abierta', async () => {
  tx.aperturaCaja.findFirst.mockResolvedValue({ id: 7 }); // ya existe una abierta

  await expect(
    service.abrirCaja({ montoInicial: 100 }, { id: 1, email: 'qa@test.com' }),
  ).rejects.toThrow(ConflictException);

  expect(tx.aperturaCaja.create).not.toHaveBeenCalled(); // no debe escribir nada
});

it('calcula la diferencia como faltante cuando lo contado es menor a lo esperado', async () => {
  tx.aperturaCaja.findUnique.mockResolvedValue({
    id: 1, anulado: false, montoInicial: 500, estado: { nombre: 'Abierta' },
  });
  tx.ticketPago.aggregate.mockResolvedValue({ _sum: { monto: 1250 } });
  tx.gastos.aggregate.mockResolvedValue({ _sum: { monto: 150 } });
  tx.estadoCaja.findFirst.mockResolvedValue({ id: 2, nombre: 'Cerrada' });
  tx.cierreCaja.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 9, ...data }));
  tx.aperturaCaja.update.mockResolvedValue({ id: 1 });

  const { cierre } = await service.cerrarCaja(1, { montoContado: 1590 }, { id: 1 });

  expect(cierre.montoEsperado).toBe(1600); // 500 + 1250 - 150
  expect(cierre.diferencia).toBe(-10);     // faltante
});

it('registra la operación en bitácora dentro de la misma transacción', async () => {
  // ...preparar mocks del camino feliz...
  await service.abrirCaja({ montoInicial: 100 }, { id: 1 });

  expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
    tx, // el mismo cliente transaccional, no this.prisma
    expect.objectContaining({ accion: 'APERTURA_CAJA', modulo: 'Cajas' }),
  );
});

it('da de baja lógicamente, nunca con delete', async () => {
  tx.aperturaCaja.findUnique.mockResolvedValue({ id: 1, estado: { nombre: 'Abierta' } });
  tx.aperturaCaja.update.mockResolvedValue({ id: 1, anulado: true });

  await service.anularApertura(1, { id: 1 });

  expect(tx.aperturaCaja.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ anulado: true }) }),
  );
  expect((tx.aperturaCaja as any).delete).toBeUndefined();
});
```

## 3. Plantilla e2e (`test/<modulo>.e2e-spec.ts`)

Corre contra la BD de desarrollo. **Nunca borrar**: anular y restaurar estado.

```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

const PREFIJO = 'QA-TEST-';

describe('Cajas (e2e)', () => {
  let app: INestApplication;
  let tokenConPermiso: string;
  let tokenSinPermiso: string;
  const creados: number[] = [];

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = modulo.createNestApplication();
    // Replicar la configuración de src/main.ts o los 400 esperados no se producirán
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true, forbidNonWhitelisted: true, transform: true,
      transformOptions: { enableImplicitConversion: true },
    }));
    await app.init();

    const login = async (correo: string, contrasena: string) =>
      (await request(app.getHttpServer()).post('/auth/login').send({ correo, contrasena }))
        .body.access_token;

    tokenConPermiso = await login(process.env.QA_USER!, process.env.QA_PASS!);
    tokenSinPermiso = await login(process.env.QA_USER_SIN_PERMISO!, process.env.QA_PASS_SIN_PERMISO!);

    // Salvaguarda: no interferir con una caja real abierta
    const actual = await request(app.getHttpServer())
      .get('/cajas/actual').set('Authorization', `Bearer ${tokenConPermiso}`);
    if (actual.body?.id) {
      throw new Error(
        `Hay una caja abierta real (ID ${actual.body.id}). Abortando para no alterar el estado de producción.`,
      );
    }
  });

  afterAll(async () => {
    // Limpieza SOLO por soft delete, vía los endpoints del módulo
    for (const id of creados) {
      await request(app.getHttpServer())
        .delete(`/cajas/${id}`).set('Authorization', `Bearer ${tokenConPermiso}`);
    }
    await app.close();
  });

  describe('protección de rutas', () => {
    it('401 sin token', () =>
      request(app.getHttpServer()).get('/cajas').expect(401));

    it('403 con token sin el permiso requerido', () =>
      request(app.getHttpServer())
        .get('/cajas').set('Authorization', `Bearer ${tokenSinPermiso}`).expect(403));

    it('200 con el permiso correcto', () =>
      request(app.getHttpServer())
        .get('/cajas').set('Authorization', `Bearer ${tokenConPermiso}`).expect(200));
  });

  it('impide abrir dos cajas simultáneas', async () => {
    const primera = await request(app.getHttpServer())
      .post('/cajas/apertura').set('Authorization', `Bearer ${tokenConPermiso}`)
      .send({ montoInicial: 100, observaciones: `${PREFIJO}apertura` })
      .expect(201);
    creados.push(primera.body.id);

    await request(app.getHttpServer())
      .post('/cajas/apertura').set('Authorization', `Bearer ${tokenConPermiso}`)
      .send({ montoInicial: 200 })
      .expect(409);
  });
});
```

Credenciales por variables de entorno (`QA_USER`, `QA_PASS`, `QA_USER_SIN_PERMISO`, `QA_PASS_SIN_PERMISO`), nunca escritas en el spec.

## 4. Payloads de seguridad

```ts
const PAYLOADS_XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
  'javascript:alert(1)',
];

const PAYLOADS_SQLI = [
  "' OR 1=1--",
  "'; DROP TABLE Usuario;--",
  "1 UNION SELECT null,null--",
  "admin'--",
];

it.each(PAYLOADS_SQLI)('trata %s como texto literal, sin alterar la consulta', async (payload) => {
  const res = await request(app.getHttpServer())
    .post('/tipos-gasto').set('Authorization', `Bearer ${tokenConPermiso}`)
    .send({ nombre: `${PREFIJO}${payload}` });

  expect([201, 400, 409]).toContain(res.status); // nunca 500
  if (res.status === 201) {
    expect(res.body.nombre).toBe(`${PREFIJO}${payload}`); // se guardó literal
    creados.push(res.body.id);
  }
});

it.each(PAYLOADS_XSS)('devuelve %s como JSON, no como HTML', async (payload) => {
  const res = await request(app.getHttpServer())
    .post('/tipos-gasto').set('Authorization', `Bearer ${tokenConPermiso}`)
    .send({ nombre: `${PREFIJO}${payload}` });

  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.status).not.toBe(500);
  if (res.status === 201) creados.push(res.body.id);
});

it('rechaza campos no declarados en el DTO', () =>
  request(app.getHttpServer())
    .post('/tipos-gasto').set('Authorization', `Bearer ${tokenConPermiso}`)
    .send({ nombre: `${PREFIJO}x`, campoInventado: 'malicioso', id: 999 })
    .expect(400));
```

## 5. Comandos

```bash
npm run build                          # debe pasar antes de cualquier prueba
npm test                               # unitarias (src/**/*.spec.ts)
npm test -- src/cajas                  # unitarias de un módulo
npm run test:cov                       # cobertura
npm run test:e2e                       # e2e (test/**/*.e2e-spec.ts)

grep -rn '\$queryRaw\|\$executeRaw\|Unsafe' src/     # SQL crudo: esperado vacío
git ls-files --error-unmatch .env                    # debe fallar (.env no versionado)

# Bajas duras. Filtra el decorador @Delete() para dejar solo llamadas reales a Prisma.
grep -rn '\.delete(\|\.deleteMany(' src/
```

Resultado conocido al escribir esta skill (cualquier línea **adicional** es un hallazgo nuevo):

```
src/acciones/acciones.service.ts:126,130,135        borrado en cascada de Permisos/ModuloAccion/Accion
src/modulo-acciones/modulo-acciones.service.ts:142,146
src/usuarios/usuarios.service.ts:379                reemplazo de permisos (borra los previos)
```

Ningún módulo nuevo debe agregar `.delete(` / `.deleteMany(`: la convención del proyecto es `anulado: true`.
