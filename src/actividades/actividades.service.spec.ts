import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { ActividadesService } from './actividades.service';
import { AlmacenamientoImagenesService } from './almacenamiento-imagenes.service';

const AUTOR = { id: 1, email: 'autor@test.com' };
const OTRO = { id: 2, email: 'otro@test.com' };

/** Base UTC-6, igual que el resto del proyecto. */
const desdeAhora = (ms: number) => new Date(Date.now() - 6 * 3600_000 + ms);

const actividadBase = (extra: any = {}) => ({
  id: 10,
  idUsuarioAutor: AUTOR.id,
  nombreActividad: 'Jornada de reforestación',
  descripcionActividad: 'Siembra en el sector norte',
  fechaInicio: desdeAhora(-86_400_000),
  fechaFin: desdeAhora(86_400_000),
  anulado: false,
  ...extra,
});

describe('ActividadesService', () => {
  let service: ActividadesService;
  let prisma: any;
  let almacenamiento: any;

  beforeEach(async () => {
    const tx: any = {
      actividadesParque: {
        create: jest.fn(({ data }: any) => Promise.resolve({ id: 10, ...data })),
        update: jest.fn(({ data }: any) => Promise.resolve({ ...actividadBase(), ...data })),
      },
      sectorParque: { findUnique: jest.fn().mockResolvedValue({ id: 1, anulado: false }) },
      usuario: { findUnique: jest.fn().mockResolvedValue({ id: 1, nombre: 'Autor', anulado: false }) },
    };

    prisma = {
      $transaction: jest.fn((cb: any) => cb(tx)),
      tx,
      actividadesParque: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
      imagenActividad: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn() },
    };

    almacenamiento = {
      validar: jest.fn(),
      guardar: jest.fn().mockReturnValue('1234-abcd.png'),
      existe: jest.fn().mockReturnValue(true),
      rutaDe: jest.fn().mockReturnValue('/uploads/actividades/1234-abcd.png'),
      eliminar: jest.fn(),
    };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [
        ActividadesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AlmacenamientoImagenesService, useValue: almacenamiento },
      ],
    }).compile();

    service = modulo.get<ActividadesService>(ActividadesService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('crear', () => {
    const dto = {
      nombreActividad: 'Jornada de reforestación',
      descripcionActividad: 'Siembra en el sector norte',
      fechaInicio: new Date().toISOString(),
    };

    it('registra al usuario autenticado como autor', async () => {
      const res = await service.crear(dto, AUTOR);
      expect(res.idUsuarioAutor).toBe(AUTOR.id);
    });

    it('rechaza una ventana con fin anterior al inicio', async () => {
      await expect(
        service.crear(
          { ...dto, fechaInicio: '2026-08-20T00:00:00Z', fechaFin: '2026-08-19T00:00:00Z' },
          AUTOR,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('acepta publicaciones sin fecha de fin (no expiran)', async () => {
      const res = await service.crear(dto, AUTOR);
      expect(res.fechaFin).toBeNull();
    });

    it('rechaza si no se puede identificar al autor', async () => {
      await expect(service.crear(dto, undefined)).rejects.toThrow(BadRequestException);
    });
  });

  // El permiso habilita publicar y mantener lo propio, no tocar lo ajeno.
  describe('autoría', () => {
    it('impide que otro usuario edite la publicación', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(actividadBase());

      await expect(
        service.actualizar(10, { nombreActividad: 'Secuestrada' }, OTRO),
      ).rejects.toThrow(ForbiddenException);
    });

    it('impide que otro usuario la anule', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(actividadBase());

      await expect(service.anular(10, OTRO)).rejects.toThrow(ForbiddenException);
    });

    it('permite al autor editarla', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(actividadBase());

      const res = await service.actualizar(10, { nombreActividad: 'Corregida' }, AUTOR);
      expect(res.nombreActividad).toBe('Corregida');
    });

    it('impide que otro usuario suba imágenes', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(actividadBase());

      await expect(
        service.agregarImagen(
          10,
          { originalname: 'a.png', buffer: Buffer.from(''), mimetype: 'image/png', size: 10 },
          OTRO,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(almacenamiento.guardar).not.toHaveBeenCalled();
    });
  });

  describe('ventana de visibilidad', () => {
    it('marca como vigente una publicación dentro de su ventana', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(actividadBase());

      const res = await service.findOne(10, AUTOR.id);
      expect(res.vigente).toBe(true);
      expect(res.expirada).toBe(false);
    });

    it('el autor ve su publicación expirada, marcada como tal', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(
        actividadBase({ fechaFin: desdeAhora(-3600_000) }),
      );

      const res = await service.findOne(10, AUTOR.id);
      expect(res.expirada).toBe(true);
      expect(res.esAutor).toBe(true);
    });

    // Fuera de la ventana no se muestra a terceros aunque tengan permiso.
    it('oculta a los demás una publicación expirada', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(
        actividadBase({ fechaFin: desdeAhora(-3600_000) }),
      );

      await expect(service.findOne(10, OTRO.id)).rejects.toThrow(NotFoundException);
    });

    it('oculta a los demás una publicación aún no iniciada', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(
        actividadBase({ fechaInicio: desdeAhora(86_400_000), fechaFin: null }),
      );

      await expect(service.findOne(10, OTRO.id)).rejects.toThrow(NotFoundException);
    });

    it('oculta a los demás una publicación anulada', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(actividadBase({ anulado: true }));

      await expect(service.findOne(10, OTRO.id)).rejects.toThrow(NotFoundException);
    });
  });

  // El listado no puede mostrar lo que `findOne` oculta con 404: si difieren,
  // el `total` de la paginación cuenta filas que el usuario no debería ver.
  describe('listado: coherencia con la visibilidad del detalle', () => {
    const whereDe = () => prisma.actividadesParque.findMany.mock.calls[0][0].where;

    beforeEach(() => {
      prisma.actividadesParque.findMany.mockResolvedValue([]);
      prisma.actividadesParque.count.mockResolvedValue(0);
    });

    it('aplica la ventana a las ajenas aunque se pida incluirExpiradas', async () => {
      await service.findAll({ incluirExpiradas: 'true' } as any, OTRO.id);

      const ventana = whereDe().AND.find((c: any) =>
        c.OR?.some((o: any) => o.fechaInicio),
      );
      expect(ventana).toBeDefined();
      expect(ventana.OR).toContainEqual({ idUsuarioAutor: OTRO.id });
    });

    it('con incluirAnuladas solo suma las propias anuladas', async () => {
      await service.findAll({ incluirAnuladas: 'true' } as any, OTRO.id);

      const where = whereDe();
      expect(where.anulado).toBeUndefined();
      expect(where.AND).toContainEqual({
        OR: [{ anulado: false }, { idUsuarioAutor: OTRO.id }],
      });
    });

    it('sin el flag excluye toda anulada', async () => {
      await service.findAll({} as any, OTRO.id);

      expect(whereDe().anulado).toBe(false);
    });

    // Sin sesión, `idUsuario` es undefined: nada debe contar como propio.
    it('un usuario sin identificar no hereda publicaciones ajenas', async () => {
      await service.findAll({ incluirAnuladas: 'true' } as any, undefined);

      expect(JSON.stringify(whereDe())).toContain('"idUsuarioAutor":-1');
    });

    it('soloAnuladas devuelve únicamente anuladas, y solo las propias', async () => {
      await service.findAll({ soloAnuladas: 'true' } as any, OTRO.id);

      const where = whereDe();
      expect(where.anulado).toBe(true);
      expect(where.AND).toContainEqual({ idUsuarioAutor: OTRO.id });
    });

    // Mismo criterio que el historial de cierres de caja (cajas.service.ts).
    it('soloAnuladas tiene prioridad sobre incluirAnuladas', async () => {
      await service.findAll(
        { soloAnuladas: 'true', incluirAnuladas: 'true' } as any,
        OTRO.id,
      );

      expect(whereDe().anulado).toBe(true);
    });

    it('el total se cuenta con el mismo filtro que las filas devueltas', async () => {
      await service.findAll({ incluirAnuladas: 'true' } as any, OTRO.id);

      expect(prisma.actividadesParque.count.mock.calls[0][0].where).toEqual(whereDe());
    });
  });

  describe('imágenes', () => {
    it('guarda el archivo en disco y solo la ruta en la base', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(actividadBase());
      prisma.imagenActividad.findFirst.mockResolvedValue(null);
      prisma.imagenActividad.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 1, ...data }),
      );

      const res = await service.agregarImagen(
        10,
        { originalname: 'foto.png', buffer: Buffer.from('x'), mimetype: 'image/png', size: 100 },
        AUTOR,
      );

      expect(almacenamiento.guardar).toHaveBeenCalled();
      const guardado = prisma.imagenActividad.create.mock.calls[0][0].data;
      // Lo que se persiste es el nombre del archivo, nunca el binario.
      expect(guardado.archivo).toBe('1234-abcd.png');
      expect(JSON.stringify(guardado)).not.toContain('buffer');
      expect(res.id).toBe(1);
    });

    it('numera las imágenes en orden correlativo', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(actividadBase());
      prisma.imagenActividad.findFirst.mockResolvedValue({ orden: 4 });
      prisma.imagenActividad.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 2, ...data }),
      );

      await service.agregarImagen(
        10,
        { originalname: 'b.png', buffer: Buffer.from('x'), mimetype: 'image/png', size: 10 },
        AUTOR,
      );

      expect(prisma.imagenActividad.create.mock.calls[0][0].data.orden).toBe(5);
    });

    it('borra el archivo del disco al eliminar la imagen', async () => {
      prisma.actividadesParque.findUnique.mockResolvedValue(actividadBase());
      prisma.imagenActividad.findFirst.mockResolvedValue({ id: 1, archivo: '1234-abcd.png' });

      await service.eliminarImagen(10, 1, AUTOR);

      expect(prisma.imagenActividad.delete).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(almacenamiento.eliminar).toHaveBeenCalledWith('1234-abcd.png');
    });
  });

  describe('paginación', () => {
    const args = () => prisma.actividadesParque.findMany.mock.calls[0][0];

    beforeEach(() => {
      prisma.actividadesParque.findMany.mockResolvedValue([]);
      prisma.actividadesParque.count.mockResolvedValue(0);
    });

    // Actividades comparte la medida de página, pero NO el tope: su máximo es 100
    // porque cada fila arrastra sus imágenes. Esa diferencia es la que se blinda.
    it('reparte de 20 en 20', async () => {
      const res = await service.findAll({} as any, OTRO.id);

      expect(res.limite).toBe(20);
      expect(args().take).toBe(20);
    });

    it('traduce página y límite a skip/take', async () => {
      await service.findAll({ pagina: 3, limite: 20 } as any, OTRO.id);

      expect(args()).toMatchObject({ skip: 40, take: 20 });
    });

    it('recorta un límite fuera de rango al tope del módulo', async () => {
      const res = await service.findAll({ limite: 500 } as any, OTRO.id);

      expect(res.limite).toBe(100);
    });

    // Sin el desempate, SQL Server no garantiza un orden estable entre páginas:
    // varias publicaciones pueden compartir `fechaInicio`.
    it('ordena por fecha de inicio con desempate por id', async () => {
      await service.findAll({} as any, OTRO.id);

      expect(args().orderBy).toEqual([{ fechaInicio: 'desc' }, { id: 'desc' }]);
    });
  });
});
