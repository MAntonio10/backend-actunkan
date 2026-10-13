import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from './bitacora.service';

describe('BitacoraService', () => {
  let service: BitacoraService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      bitacora: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 15, accion: 'CREAR_USUARIO' }]),
        count: jest.fn().mockResolvedValue(9432),
      },
    };

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        BitacoraService,
        { provide: PrismaService, useValue: prisma },
      ],
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

      expect(prisma.bitacora.count.mock.calls[0][0].where).toEqual(
        argsFindMany().where,
      );
    });

    // El desempate pesa aquí más que en ningún otro listado: la bitácora escribe
    // varias filas en el mismo segundo.
    it('ordena por fecha con desempate por id', async () => {
      await service.findAll({});

      expect(argsFindMany().orderBy).toEqual([
        { fecha: 'desc' },
        { id: 'desc' },
      ]);
    });

    /**
     * El orden lo decide quien consulta porque con la paginación en el servidor el
     * frontend ya no puede: invertir el arreglo recibido reordena la página visible
     * y nada más, así que el control diría «más antiguo primero» mostrando los 20
     * registros más recientes al revés.
     */
    it('puede pedirse del más antiguo al más reciente', async () => {
      await service.findAll({ orden: 'asc' });

      expect(argsFindMany().orderBy).toEqual([{ fecha: 'asc' }, { id: 'asc' }]);
    });

    /**
     * Lo que rompería en silencio: un `id: 'desc'` fijo. El listado se vería
     * ordenado —la fecha manda— pero dentro de cada segundo repetido las filas
     * saldrían al revés del resto, y en la bitácora casi todos los segundos están
     * repetidos. Es justo la clase de error que el desempate venía a evitar.
     */
    it('el desempate acompaña al sentido de la fecha, no queda fijo', async () => {
      await service.findAll({ orden: 'asc' });

      const [porFecha, porId] = argsFindMany().orderBy;
      expect(porId.id).toBe(porFecha.fecha);
    });

    it('un orden no reconocido cae en el de siempre', async () => {
      await service.findAll({ orden: 'DESC' as any });

      expect(argsFindMany().orderBy).toEqual([
        { fecha: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('la búsqueda libre abarca los cinco campos que mostraba la pantalla', async () => {
      await service.findAll({ buscar: 'anular' });

      expect(argsFindMany().where.OR).toEqual([
        { descripcion: { contains: 'anular' } },
        { accion: { contains: 'anular' } },
        { modulo: { contains: 'anular' } },
        { usuarioNombre: { contains: 'anular' } },
        { usuario: { correo: { contains: 'anular' } } },
      ]);
    });

    // Si el contador no viera la búsqueda, el paginador anunciaría páginas que no
    // existen: 1627 resultados para un término que solo tiene tres.
    it('el total también respeta la búsqueda', async () => {
      await service.findAll({ buscar: 'anular' });

      expect(prisma.bitacora.count.mock.calls[0][0].where).toEqual(
        argsFindMany().where,
      );
    });

    it('la búsqueda se combina con los filtros, no los reemplaza', async () => {
      await service.findAll({ buscar: 'anular', modulo: 'Cajas' });

      expect(argsFindMany().where.modulo).toEqual({ contains: 'Cajas' });
      expect(argsFindMany().where.OR).toHaveLength(5);
    });

    it('filtra por módulo y acción con coincidencia parcial', async () => {
      await service.findAll({ modulo: 'Usuarios', accion: 'CREAR' });

      expect(argsFindMany().where).toEqual({
        modulo: { contains: 'Usuarios' },
        accion: { contains: 'CREAR' },
      });
    });

    it('acota por rango de fechas', async () => {
      await service.findAll({
        fechaInicio: '2026-01-01',
        fechaFin: '2026-01-31',
      });

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
