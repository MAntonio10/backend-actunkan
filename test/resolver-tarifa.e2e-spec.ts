/**
 * Integración de `resolverTarifaEn` contra la base de datos real.
 *
 * Las pruebas unitarias verifican la forma de la consulta; estas verifican que SQL
 * Server la interprete como se espera, con fechas `DateTime2` reales.
 *
 * ## Nada se persiste
 *
 * `Tarifa` es el catálogo de precios en producción: dejar filas de prueba cambiaría
 * lo que se le cobra a un visitante. Todo lo que escribe corre dentro de una
 * `$transaction` que termina lanzando `ROLLBACK_INTENCIONAL`, así que la base queda
 * igual que antes. Al final se comprueba que el conteo de tarifas no cambió.
 */
import { PrismaClient } from '@prisma/client';
import { resolverTarifaEn, resolverTarifaGuiaEn } from '../src/tarifas/resolver-tarifa.util';
import { getFechaUTC6 } from '../src/common/utils/date.util';

const ROLLBACK = 'ROLLBACK_INTENCIONAL';

/** Ejecuta el cuerpo y revierte siempre, devuelva lo que devuelva. */
async function enTransaccionRevertida<T>(
  prisma: PrismaClient,
  cuerpo: (tx: any) => Promise<T>,
): Promise<T> {
  let resultado: T;

  try {
    await prisma.$transaction(async (tx) => {
      resultado = await cuerpo(tx);
      throw new Error(ROLLBACK);
    });
  } catch (error: any) {
    if (error.message !== ROLLBACK) throw error;
  }

  return resultado!;
}

describe('resolverTarifaEn (integración con SQL Server)', () => {
  let prisma: PrismaClient;
  let clave: { idAtraccion: number; idOrigen: number; idTipoVisitante: number };
  let tarifasIniciales: number;

  beforeAll(async () => {
    prisma = new PrismaClient();

    const actual = await prisma.tarifa.findFirst({
      where: { vigenteHasta: null, anulado: false },
    });

    if (!actual) {
      throw new Error('No hay tarifas cargadas: ejecutar prisma/seed-tickets.ts antes.');
    }

    clave = {
      idAtraccion: actual.idAtraccion,
      idOrigen: actual.idOrigen,
      idTipoVisitante: actual.idTipoVisitante,
    };

    tarifasIniciales = await prisma.tarifa.count();
  });

  afterAll(async () => {
    // Si algo se hubiera escapado de un rollback, el catálogo de precios quedaría alterado.
    expect(await prisma.tarifa.count()).toBe(tarifasIniciales);
    await prisma.$disconnect();
  });

  describe('sobre los datos reales, sin escribir', () => {
    it('resuelve la tarifa de hoy', async () => {
      const tarifa = await resolverTarifaEn(prisma, clave);

      expect(tarifa).not.toBeNull();
      expect(tarifa.vigenteHasta).toBeNull();
    });

    /**
     * El bug que motivó esta función y el que ya nos mordió dos veces: las vigencias
     * se sellan con `getFechaUTC6()`, 6 horas atrás. Si se comparara contra la hora
     * real sin convertir, una tarifa creada hace menos de 6 horas no se encontraría.
     */
    it('encuentra la tarifa vigente aunque se consulte con la hora real', async () => {
      const tarifa = await resolverTarifaEn(prisma, clave, new Date());

      expect(tarifa).not.toBeNull();
    });

    it('devuelve null para una fecha anterior a que existiera el catálogo', async () => {
      const tarifa = await resolverTarifaEn(prisma, clave, new Date('2015-01-01T12:00:00.000Z'));

      expect(tarifa).toBeNull();
    });

    it('resuelve la tarifa de guía vigente', async () => {
      const tarifa = await resolverTarifaGuiaEn(prisma);

      expect(tarifa).not.toBeNull();
      expect(Number(tarifa.precio)).toBeGreaterThan(0);
    });
  });

  describe('cambio de precio: qué tarifa rige a cada lado del corte', () => {
    /**
     * Reproduce lo que hace `TarifasService.actualizar`: cierra la vigente con
     * `vigenteHasta = corte` y abre una nueva con `vigenteDesde = corte`.
     * `corte` es un instante **real**; en la base se guarda desplazado, igual que
     * en producción.
     */
    const montarCambioDePrecio = async (tx: any, corteReal: Date) => {
      const corteEnBase = getFechaUTC6(corteReal);

      const vigente = await tx.tarifa.findFirst({
        where: { ...clave, vigenteHasta: null, anulado: false },
      });

      await tx.tarifa.update({
        where: { id: vigente.id },
        data: { vigenteHasta: corteEnBase, precio: '11.0000' },
      });

      await tx.tarifa.create({
        data: {
          ...clave,
          precio: '99.0000',
          vigenteDesde: corteEnBase,
          fechaCreacion: corteEnBase,
          fechaActualizacion: corteEnBase,
        },
      });
    };

    it('antes del corte rige el precio viejo; después, el nuevo', async () => {
      const corte = new Date(Date.now() - 2 * 60 * 60 * 1000); // hace 2 horas

      const resultado = await enTransaccionRevertida(prisma, async (tx) => {
        await montarCambioDePrecio(tx, corte);

        const antes = await resolverTarifaEn(
          tx,
          clave,
          new Date(corte.getTime() - 60 * 60 * 1000),
        );
        const despues = await resolverTarifaEn(
          tx,
          clave,
          new Date(corte.getTime() + 60 * 60 * 1000),
        );

        return { antes: Number(antes.precio), despues: Number(despues.precio) };
      });

      expect(resultado.antes).toBe(11);
      expect(resultado.despues).toBe(99);
    });

    // Con `>=` en vez de `>` las dos filas aplicarían y el precio saldría al azar.
    it('en el instante exacto del corte rige solo la nueva', async () => {
      const corte = new Date(Date.now() - 2 * 60 * 60 * 1000);

      const precio = await enTransaccionRevertida(prisma, async (tx) => {
        await montarCambioDePrecio(tx, corte);
        const tarifa = await resolverTarifaEn(tx, clave, corte);
        return Number(tarifa.precio);
      });

      expect(precio).toBe(99);
    });

    /**
     * El caso de la venta offline: se cobró ayer con el precio de ayer y se sube
     * hoy, cuando ya rige otro. Sin resolución histórica se recalcularía con el
     * precio de hoy y aparecería una discrepancia inexistente.
     */
    it('una venta de ayer se recalcula con el precio de ayer', async () => {
      const corte = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const ventaDeAyer = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const precio = await enTransaccionRevertida(prisma, async (tx) => {
        await montarCambioDePrecio(tx, corte);
        const tarifa = await resolverTarifaEn(tx, clave, ventaDeAyer);
        return Number(tarifa.precio);
      });

      expect(precio).toBe(11);
    });

    it('no devuelve una tarifa anulada aunque su ventana cubra la fecha', async () => {
      const resultado = await enTransaccionRevertida(prisma, async (tx) => {
        const vigente = await tx.tarifa.findFirst({
          where: { ...clave, vigenteHasta: null, anulado: false },
        });

        await tx.tarifa.update({ where: { id: vigente.id }, data: { anulado: true } });

        return resolverTarifaEn(tx, clave, new Date());
      });

      expect(resultado).toBeNull();
    });
  });

  describe('la transacción de prueba realmente se revierte', () => {
    it('el precio alterado no sobrevive fuera de la transacción', async () => {
      const antes = await prisma.tarifa.findFirst({
        where: { ...clave, vigenteHasta: null, anulado: false },
      });

      await enTransaccionRevertida(prisma, async (tx) => {
        await tx.tarifa.update({
          where: { id: antes!.id },
          data: { precio: '12345.0000' },
        });

        const dentro = await tx.tarifa.findUnique({ where: { id: antes!.id } });
        expect(Number(dentro.precio)).toBe(12345);
      });

      const despues = await prisma.tarifa.findUnique({ where: { id: antes!.id } });
      expect(Number(despues!.precio)).toBe(Number(antes!.precio));
    });
  });
});
