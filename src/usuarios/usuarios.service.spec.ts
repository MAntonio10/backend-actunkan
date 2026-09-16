import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { UsuariosService } from './usuarios.service';

const usuarioBase = (extra: any = {}) => ({
  id: 4,
  nombre: 'Carlos Mendoza',
  correo: 'carlos@aktunkan.com',
  contrasena: '$2b$10$hashquenuncadebesalir',
  anulado: false,
  puesto: { id: 2, nombre: 'Taquillero' },
  permiso: [],
  ...extra,
});

describe('UsuariosService', () => {
  let service: UsuariosService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      usuario: {
        findMany: jest.fn().mockResolvedValue([usuarioBase()]),
        count: jest.fn().mockResolvedValue(137),
      },
    };

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [UsuariosService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = modulo.get<UsuariosService>(UsuariosService);
  });

  afterEach(() => jest.restoreAllMocks());

  const argsFindMany = () => prisma.usuario.findMany.mock.calls[0][0];

  describe('findAll', () => {
    it('devuelve el sobre paginado, no un arreglo plano', async () => {
      const res = await service.findAll({});

      expect(Object.keys(res)).toEqual(['datos', 'total', 'pagina', 'limite']);
      expect(res.pagina).toBe(1);
      expect(res.limite).toBe(20);
    });

    // El listado es una página; el contador describe el filtro completo. Si alguien
    // lo cambiara por `datos.length`, el paginador del frontend mostraría una sola
    // página aunque hubiera 137 usuarios.
    it('el total sale del count, no del tamaño de la página', async () => {
      const res = await service.findAll({});

      expect(res.total).toBe(137);
      expect(res.datos).toHaveLength(1);
    });

    it('traduce página y límite a skip/take', async () => {
      await service.findAll({ pagina: 3, limite: 20 });

      expect(argsFindMany()).toMatchObject({ skip: 40, take: 20 });
    });

    it('el total se cuenta con el mismo filtro que las filas devueltas', async () => {
      await service.findAll({ incluirAnulados: 'true' });

      expect(prisma.usuario.count.mock.calls[0][0].where).toEqual(argsFindMany().where);
    });

    // Sin el desempate, SQL Server no garantiza un orden estable entre páginas:
    // dos usuarios homónimos podrían repetirse o perderse al pasar de página.
    it('ordena por nombre con desempate por id', async () => {
      await service.findAll({});

      expect(argsFindMany().orderBy).toEqual([{ nombre: 'asc' }, { id: 'asc' }]);
    });

    it('oculta los usuarios anulados salvo que se pidan', async () => {
      await service.findAll({});

      expect(argsFindMany().where).toEqual({ anulado: false });
    });

    it('incluirAnulados=true levanta el filtro', async () => {
      await service.findAll({ incluirAnulados: 'true' });

      expect(argsFindMany().where).toEqual({});
    });

    // El flag se compara contra la cadena exacta: cualquier otro valor se ignora,
    // que es como se comportaba antes de recibir un DTO.
    it('un valor distinto de "true" no levanta el filtro', async () => {
      await service.findAll({ incluirAnulados: '1' });

      expect(argsFindMany().where).toEqual({ anulado: false });
    });

    it('nunca expone la contraseña', async () => {
      const res = await service.findAll({});

      expect(res.datos[0]).not.toHaveProperty('contrasena');
      expect(res.datos[0]).toMatchObject({ id: 4, nombre: 'Carlos Mendoza' });
    });
  });
});
