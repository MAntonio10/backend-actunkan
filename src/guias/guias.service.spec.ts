import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { GuiasService } from './guias.service';

describe('GuiasService', () => {
  let service: GuiasService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      guia: {
        findMany: jest.fn().mockResolvedValue([{ id: 7, nombre: 'Juan Tecún' }]),
        count: jest.fn().mockResolvedValue(58),
      },
    };

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [GuiasService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = modulo.get<GuiasService>(GuiasService);
  });

  afterEach(() => jest.restoreAllMocks());

  const argsFindMany = () => prisma.guia.findMany.mock.calls[0][0];

  describe('findAll', () => {
    it('devuelve el sobre paginado, no un arreglo plano', async () => {
      const res = await service.findAll({});

      expect(Object.keys(res)).toEqual(['datos', 'total', 'pagina', 'limite']);
      expect(res.total).toBe(58);
    });

    it('traduce página y límite a skip/take', async () => {
      await service.findAll({ pagina: 2, limite: 25 });

      expect(argsFindMany()).toMatchObject({ skip: 25, take: 25 });
    });

    it('el total se cuenta con el mismo filtro que las filas devueltas', async () => {
      await service.findAll({ buscar: 'Tecún', incluirAnulados: 'true' });

      expect(prisma.guia.count.mock.calls[0][0].where).toEqual(argsFindMany().where);
    });

    it('ordena por nombre con desempate por id', async () => {
      await service.findAll({});

      expect(argsFindMany().orderBy).toEqual([{ nombre: 'asc' }, { id: 'asc' }]);
    });

    it('busca por nombre y esconde los anulados por defecto', async () => {
      await service.findAll({ buscar: 'Tecún' });

      expect(argsFindMany().where).toEqual({
        anulado: false,
        nombre: { contains: 'Tecún' },
      });
    });

    it('incluirAnulados=true levanta el filtro de baja', async () => {
      await service.findAll({ incluirAnulados: 'true' });

      expect(argsFindMany().where).toEqual({});
    });
  });
});
