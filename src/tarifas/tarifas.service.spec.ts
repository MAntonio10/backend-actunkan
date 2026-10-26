import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TarifasService } from './tarifas.service';
import { BitacoraService } from '../bitacora/bitacora.service';

describe('TarifasService', () => {
  let service: TarifasService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      tarifa: {
        findMany: jest.fn().mockResolvedValue([{ id: 11, precio: 20 }]),
        count: jest.fn().mockResolvedValue(214),
      },
    };

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [TarifasService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = modulo.get<TarifasService>(TarifasService);
  });

  afterEach(() => jest.restoreAllMocks());

  const argsFindMany = () => prisma.tarifa.findMany.mock.calls[0][0];

  describe('findHistorico', () => {
    it('devuelve el sobre paginado', async () => {
      const res = await service.findHistorico({});

      expect(Object.keys(res)).toEqual(['datos', 'total', 'pagina', 'limite']);
      expect(res.total).toBe(214);
    });

    it('traduce página y límite a skip/take', async () => {
      await service.findHistorico({ pagina: 2, limite: 10 });

      expect(argsFindMany()).toMatchObject({ skip: 10, take: 10 });
    });

    it('el total se cuenta con el mismo filtro que las filas devueltas', async () => {
      await service.findHistorico({ idAtraccion: 1, idOrigen: 2 });

      expect(prisma.tarifa.count.mock.calls[0][0].where).toEqual(
        argsFindMany().where,
      );
    });

    it('cierra el orden con un desempate por id', async () => {
      await service.findHistorico({});

      expect(argsFindMany().orderBy).toEqual([
        { idAtraccion: 'asc' },
        { idOrigen: 'asc' },
        { vigenteDesde: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('filtra por atracción y origen', async () => {
      await service.findHistorico({ idAtraccion: 1, idOrigen: 2 });

      expect(argsFindMany().where).toEqual({ idAtraccion: 1, idOrigen: 2 });
    });

    // Se conserva la guarda original: no existe atracción con id 0, así que un 0
    // se ignora en vez de devolver un listado vacío.
    it('ignora un id 0, como antes de recibir un DTO', async () => {
      await service.findHistorico({ idAtraccion: 0 });

      expect(argsFindMany().where).toEqual({});
    });
  });

  describe('findVigentes', () => {
    // El catálogo de tarifas vigentes alimenta el formulario de emisión: si alguien
    // lo paginara "por consistencia", el formulario se quedaría sin precios.
    it('sigue devolviendo un arreglo plano, sin paginar', async () => {
      const res = await service.findVigentes();

      expect(Array.isArray(res)).toBe(true);
      expect(argsFindMany().skip).toBeUndefined();
      expect(argsFindMany().take).toBeUndefined();
    });
  });

  describe('actualizarDuracionRecorrido', () => {
    let tx: any;

    beforeEach(() => {
      tx = {
        atraccion: { findUnique: jest.fn().mockResolvedValue({ id: 1, nombre: 'Cuevas', anulado: false }) },
        tipoRecorrido: { findUnique: jest.fn().mockResolvedValue({ id: 2, nombre: 'Recorrido corto', anulado: false }) },
        duracionRecorrido: {
          findUnique: jest.fn().mockResolvedValue({ minutos: 45 }),
          upsert: jest.fn().mockResolvedValue({ minutos: 30 }),
        },
        usuario: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      prisma.$transaction = jest.fn((fn: any) => fn(tx));
      jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue(undefined as any);
    });

    it('guarda los minutos de esa atracción y ese recorrido, sin tocar los demás', async () => {
      await service.actualizarDuracionRecorrido({ idAtraccion: 1, idTipoRecorrido: 2, minutos: 30 });

      const args = tx.duracionRecorrido.upsert.mock.calls[0][0];
      expect(args.where).toEqual({ idAtraccion_idTipoRecorrido: { idAtraccion: 1, idTipoRecorrido: 2 } });
      expect(args.update).toMatchObject({ minutos: 30 });
      expect(args.create).toMatchObject({ idAtraccion: 1, idTipoRecorrido: 2, minutos: 30 });
    });

    it('rechaza una atracción anulada', async () => {
      tx.atraccion.findUnique.mockResolvedValue({ id: 1, nombre: 'Cuevas', anulado: true });

      await expect(
        service.actualizarDuracionRecorrido({ idAtraccion: 1, idTipoRecorrido: 2, minutos: 30 }),
      ).rejects.toThrow('anulada');
      expect(tx.duracionRecorrido.upsert).not.toHaveBeenCalled();
    });
  });
});
