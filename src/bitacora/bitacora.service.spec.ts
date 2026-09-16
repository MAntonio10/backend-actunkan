import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from './bitacora.service';

describe('BitacoraService', () => {
  let service: BitacoraService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      bitacora: {
        findMany: jest.fn().mockResolvedValue([{ id: 15, accion: 'CREAR_USUARIO' }]),
        count: jest.fn().mockResolvedValue(9432),
      },
    };

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [BitacoraService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = modulo.get<BitacoraService>(BitacoraService);
  });

  afterEach(() => jest.restoreAllMocks());

  const argsFindMany = () => prisma.bitacora.findMany.mock.calls[0][0];

  describe('findAll', () => {
    it('devuelve el sobre paginado, no un arreglo plano', async () => {
      const res = await service.findAll({});

      expect(Object.keys(res)).toEqual(['datos', 'total', 'pagina', 'limite']);
      expect(res.total).toBe(9432);
    });

    it('reparte de 20 en 20, como el resto de los listados', async () => {
      const res = await service.findAll({});

      expect(res.limite).toBe(20);
      expect(argsFindMany().take).toBe(20);
    });

    // Antes solo topaba con `take`: pedir la página 2 devolvía otra vez la primera.
    it('salta las páginas anteriores', async () => {
      await service.findAll({ pagina: 4, limite: 25 });

      expect(argsFindMany()).toMatchObject({ skip: 75, take: 25 });
    });

    it('el total se cuenta con el mismo filtro que las filas devueltas', async () => {
      await service.findAll({ modulo: 'Usuarios', accion: 'CREAR' });

      expect(prisma.bitacora.count.mock.calls[0][0].where).toEqual(argsFindMany().where);
    });

    // El desempate pesa aquí más que en ningún otro listado: la bitácora escribe
    // varias filas en el mismo segundo.
    it('ordena por fecha con desempate por id', async () => {
      await service.findAll({});

      expect(argsFindMany().orderBy).toEqual([{ fecha: 'desc' }, { id: 'desc' }]);
    });

    it('filtra por módulo y acción con coincidencia parcial', async () => {
      await service.findAll({ modulo: 'Usuarios', accion: 'CREAR' });

      expect(argsFindMany().where).toEqual({
        modulo: { contains: 'Usuarios' },
        accion: { contains: 'CREAR' },
      });
    });

    it('acota por rango de fechas', async () => {
      await service.findAll({ fechaInicio: '2026-01-01', fechaFin: '2026-01-31' });

      expect(argsFindMany().where.fecha).toEqual({
        gte: new Date('2026-01-01'),
        lte: new Date('2026-01-31'),
      });
    });

    it('sin filtros consulta sin condiciones', async () => {
      await service.findAll();

      expect(argsFindMany().where).toEqual({});
    });
  });
});
