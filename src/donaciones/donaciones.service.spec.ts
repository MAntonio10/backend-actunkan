import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { DonacionesService } from './donaciones.service';

const EJECUTOR = { id: 1, email: 'qa@test.com' };

const crearTxMock = () => {
  const tx: any = {
    aperturaCaja: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 9, anulado: false, estado: { nombre: 'Abierta' } }),
    },
    correlativo: { upsert: jest.fn().mockResolvedValue({ ultimoNumero: 7 }) },
    donacion: {
      create: jest.fn(({ data }: any) => Promise.resolve({ id: 30, ...data })),
      findUnique: jest.fn(),
      update: jest.fn(({ data }: any) =>
        Promise.resolve({ id: 30, numeroRecibo: 'DON-2026-000007', monto: 100, ...data }),
      ),
    },
    usuario: { findUnique: jest.fn().mockResolvedValue({ id: 1, nombre: 'QA Tester' }) },
  };
  return tx;
};

describe('DonacionesService', () => {
  let service: DonacionesService;
  let tx: any;
  let prisma: any;
  let cajasService: any;

  beforeEach(async () => {
    tx = crearTxMock();
    prisma = {
      $transaction: jest.fn((cb: any) => cb(tx)),
      donacion: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    };
    cajasService = { obtenerActual: jest.fn().mockResolvedValue({ id: 9 }) };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        DonacionesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CajasService, useValue: cajasService },
      ],
    }).compile();

    service = modulo.get<DonacionesService>(DonacionesService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('crear', () => {
    it('genera el folio con la serie DON, independiente de los tickets', async () => {
      const res = await service.crear({ monto: 100, nombreDonante: 'Ana' }, EJECUTOR);

      const anio = new Date().getFullYear();
      expect(res.numeroRecibo).toBe(`DON-${anio}-000007`);
      expect(tx.correlativo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { serie_anio: { serie: 'DON', anio } },
        }),
      );
    });

    it('asocia la donación a la caja abierta y registra en bitácora', async () => {
      const res = await service.crear({ monto: 100 }, EJECUTOR);

      expect(res.idAperturaCaja).toBe(9);
      expect(res.idUsuario).toBe(1);
      expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ accion: 'REGISTRAR_DONACION', modulo: 'Donaciones' }),
      );
    });

    // El donante puede permanecer anónimo.
    it('acepta una donación sin nombre de donante', async () => {
      const res = await service.crear({ monto: 50 }, EJECUTOR);
      expect(res.nombreDonante).toBeNull();
    });

    it('guarda el nombre sin espacios sobrantes', async () => {
      const res = await service.crear({ monto: 50, nombreDonante: '  Ana Lucía  ' }, EJECUTOR);
      expect(res.nombreDonante).toBe('Ana Lucía');
    });

    it('rechaza registrar si no hay caja abierta', async () => {
      cajasService.obtenerActual.mockResolvedValue(null);

      await expect(service.crear({ monto: 100 }, EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.donacion.create).not.toHaveBeenCalled();
    });

    it('rechaza si la caja se cerró dentro de la transacción', async () => {
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 9,
        anulado: false,
        estado: { nombre: 'Cerrada' },
      });

      await expect(service.crear({ monto: 100 }, EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.donacion.create).not.toHaveBeenCalled();
    });

    it('rechaza si no se puede identificar al usuario', async () => {
      await expect(service.crear({ monto: 100 }, undefined)).rejects.toThrow(BadRequestException);
    });
  });

  describe('anular', () => {
    it('da de baja lógicamente y guarda el motivo', async () => {
      tx.donacion.findUnique.mockResolvedValue({
        id: 30,
        numeroRecibo: 'DON-2026-000007',
        anulado: false,
        idAperturaCaja: 9,
        monto: 100,
      });

      const res = await service.anular(30, 'Error de captura', EJECUTOR);

      expect(res.anulado).toBe(true);
      expect(res.motivoAnulacion).toBe('Error de captura');
      expect(tx.donacion.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ anulado: true }) }),
      );
    });

    // Anularla tras el cierre cambiaría un arqueo ya guardado.
    it('rechaza anular si la caja de origen ya se cerró', async () => {
      tx.donacion.findUnique.mockResolvedValue({
        id: 30,
        numeroRecibo: 'DON-2026-000007',
        anulado: false,
        idAperturaCaja: 9,
      });
      tx.aperturaCaja.findUnique.mockResolvedValue({
        id: 9,
        anulado: false,
        estado: { nombre: 'Cerrada' },
      });

      await expect(service.anular(30, undefined, EJECUTOR)).rejects.toThrow(BadRequestException);
      expect(tx.donacion.update).not.toHaveBeenCalled();
    });

    it('rechaza anular dos veces', async () => {
      tx.donacion.findUnique.mockResolvedValue({
        id: 30,
        numeroRecibo: 'DON-2026-000007',
        anulado: true,
        idAperturaCaja: 9,
      });

      await expect(service.anular(30, undefined, EJECUTOR)).rejects.toThrow(BadRequestException);
    });

    it('rechaza una donación inexistente', async () => {
      tx.donacion.findUnique.mockResolvedValue(null);

      await expect(service.anular(404, undefined, EJECUTOR)).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * Un recibo anulado no recaudó nada: ese dinero salió del arqueo al anularlo.
   * Si el total lo sumara, bastaría pedir `incluirAnulados=true` para ver una
   * recaudación que no existe.
   */
  describe('findAll: la recaudación nunca cuenta recibos anulados', () => {
    const prepararAgregados = (vigentes: any, anulados: any) => {
      prisma.donacion.findMany.mockResolvedValue([]);
      prisma.donacion.count.mockResolvedValue(vigentes.count + anulados.count);
      prisma.donacion.aggregate
        .mockResolvedValueOnce({ _sum: { monto: vigentes.monto }, _count: { _all: vigentes.count } })
        .mockResolvedValueOnce({ _sum: { monto: anulados.monto }, _count: { _all: anulados.count } });
    };

    const whereDe = (llamada: number) =>
      prisma.donacion.aggregate.mock.calls[llamada][0].where;

    it('suma solo los vigentes aunque el listado incluya anulados', async () => {
      prepararAgregados({ monto: 300, count: 2 }, { monto: 500, count: 1 });

      const res = await service.findAll({ incluirAnulados: 'true' } as any);

      expect(res.metricas.montoRecaudado).toBe('300');
      expect(res.metricas.recibosVigentes).toBe(2);
    });

    it('el agregado de recaudación fuerza anulado: false', async () => {
      prepararAgregados({ monto: 300, count: 2 }, { monto: 0, count: 0 });

      await service.findAll({ incluirAnulados: 'true' } as any);

      expect(whereDe(0).anulado).toBe(false);
    });

    // Sin estas cifras, ver 3 recibos y Q300 parecería un error de cuadre.
    it('expone lo anulado por separado, para que la diferencia se explique', async () => {
      prepararAgregados({ monto: 300, count: 2 }, { monto: 500, count: 1 });

      const res = await service.findAll({ incluirAnulados: 'true' } as any);

      expect(res.metricas.recibosAnulados).toBe(1);
      expect(res.metricas.montoAnulado).toBe('500');
      expect(whereDe(1).anulado).toBe(true);
    });

    it('totalRecibos sigue cuadrando con la paginación', async () => {
      prepararAgregados({ monto: 300, count: 2 }, { monto: 500, count: 1 });

      const res = await service.findAll({ incluirAnulados: 'true' } as any);

      expect(res.metricas.totalRecibos).toBe(res.total);
      expect(res.total).toBe(3);
    });

    /**
     * Si el listado no muestra anulados, las cifras tampoco los cuentan: de lo
     * contrario la pantalla diría "1 recibo" y "24 anulados" a la vez.
     */
    it('sin el flag ni siquiera consulta los anulados', async () => {
      prisma.donacion.findMany.mockResolvedValue([]);
      prisma.donacion.count.mockResolvedValue(2);
      prisma.donacion.aggregate.mockResolvedValue({
        _sum: { monto: 300 },
        _count: { _all: 2 },
      });

      const res = await service.findAll({} as any);

      expect(res.metricas.montoRecaudado).toBe('300');
      expect(res.metricas.recibosAnulados).toBe(0);
      expect(res.metricas.montoAnulado).toBe('0');
      // Un solo agregado: el de vigentes.
      expect(prisma.donacion.aggregate).toHaveBeenCalledTimes(1);
    });

    // Propiedad que hace la pantalla verificable de un vistazo.
    it('totalRecibos siempre es vigentes + anulados', async () => {
      prepararAgregados({ monto: 300, count: 2 }, { monto: 500, count: 1 });

      const res = await service.findAll({ incluirAnulados: 'true' } as any);

      expect(res.metricas.recibosVigentes + res.metricas.recibosAnulados).toBe(
        res.metricas.totalRecibos,
      );
    });

    it('los filtros del listado también acotan la recaudación', async () => {
      prepararAgregados({ monto: 120, count: 1 }, { monto: 0, count: 0 });

      await service.findAll({ idAperturaCaja: 9, buscar: 'Fundación' } as any);

      expect(whereDe(0)).toMatchObject({ idAperturaCaja: 9, anulado: false });
      expect(whereDe(0).OR).toBeDefined();
    });
  });
});
