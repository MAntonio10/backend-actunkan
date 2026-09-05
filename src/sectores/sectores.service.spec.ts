import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../bitacora/bitacora.service';
import { SectoresService } from './sectores.service';

const EJECUTOR = { id: 1, email: 'autor@test.com' };

const sectorBase = (extra: any = {}) => ({
  id: 3,
  nombre: 'Sector Norte',
  anulado: false,
  fechaCreacion: new Date(),
  fechaActualizacion: new Date(),
  ...extra,
});

describe('SectoresService', () => {
  let service: SectoresService;
  let prisma: any;
  let tx: any;

  beforeEach(async () => {
    tx = {
      sectorParque: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(sectorBase()),
        create: jest.fn(({ data }: any) => Promise.resolve({ id: 3, ...data })),
        update: jest.fn(({ data }: any) => Promise.resolve({ ...sectorBase(), ...data })),
      },
      usuario: { findUnique: jest.fn().mockResolvedValue({ id: 1, nombre: 'Autor' }) },
    };

    prisma = {
      $transaction: jest.fn((cb: any) => cb(tx)),
      sectorParque: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    };

    jest.spyOn(BitacoraService, 'registrarEnTransaccion').mockResolvedValue({} as any);

    const modulo: TestingModule = await Test.createTestingModule({
      providers: [SectoresService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = modulo.get<SectoresService>(SectoresService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('crear', () => {
    it('guarda el sector y registra en bitácora dentro de la transacción', async () => {
      const res = await service.crear({ nombre: 'Sector Norte' }, EJECUTOR);

      expect(res.nombre).toBe('Sector Norte');
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(BitacoraService.registrarEnTransaccion).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ accion: 'CREAR_SECTOR', modulo: 'ActividadesParque' }),
      );
    });

    it('recorta los espacios del nombre', async () => {
      await service.crear({ nombre: '  Sector Sur  ' }, EJECUTOR);

      expect(tx.sectorParque.create.mock.calls[0][0].data.nombre).toBe('Sector Sur');
    });

    it('rechaza un nombre repetido', async () => {
      tx.sectorParque.findFirst.mockResolvedValue(sectorBase());

      await expect(service.crear({ nombre: 'Sector Norte' }, EJECUTOR)).rejects.toThrow(
        ConflictException,
      );
      expect(tx.sectorParque.create).not.toHaveBeenCalled();
    });

    // Crear un duplicado dejaría dos entradas idénticas en el selector del formulario.
    it('rechaza el nombre de un sector anulado y sugiere reactivarlo', async () => {
      tx.sectorParque.findFirst.mockResolvedValue(sectorBase({ anulado: true }));

      await expect(service.crear({ nombre: 'Sector Norte' }, EJECUTOR)).rejects.toThrow(
        /Reactívelo en lugar de crear otro/,
      );
    });
  });

  describe('actualizar', () => {
    it('permite conservar su propio nombre', async () => {
      tx.sectorParque.findFirst.mockResolvedValue(sectorBase({ id: 3 }));

      const res = await service.actualizar(3, { nombre: 'Sector Norte' }, EJECUTOR);
      expect(res.nombre).toBe('Sector Norte');
    });

    it('rechaza tomar el nombre de otro sector', async () => {
      tx.sectorParque.findFirst.mockResolvedValue(sectorBase({ id: 9 }));

      await expect(
        service.actualizar(3, { nombre: 'Sector Norte' }, EJECUTOR),
      ).rejects.toThrow(ConflictException);
    });

    it('devuelve 404 si el sector no existe', async () => {
      tx.sectorParque.findUnique.mockResolvedValue(null);

      await expect(service.actualizar(99, { nombre: 'X' }, EJECUTOR)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('anular y activar', () => {
    it('anula con baja lógica, nunca borra', async () => {
      const res = await service.anular(3, EJECUTOR);

      expect(res.anulado).toBe(true);
      expect(tx.sectorParque.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ anulado: true }) }),
      );
      expect((tx.sectorParque as any).delete).toBeUndefined();
    });

    it('rechaza anular uno ya anulado', async () => {
      tx.sectorParque.findUnique.mockResolvedValue(sectorBase({ anulado: true }));

      await expect(service.anular(3, EJECUTOR)).rejects.toThrow(BadRequestException);
    });

    it('reactiva un sector anulado', async () => {
      tx.sectorParque.findUnique.mockResolvedValue(sectorBase({ anulado: true }));

      const res = await service.activar(3, EJECUTOR);
      expect(res.anulado).toBe(false);
    });

    it('rechaza activar uno que ya está activo', async () => {
      await expect(service.activar(3, EJECUTOR)).rejects.toThrow(BadRequestException);
    });
  });

  describe('lectura', () => {
    it('oculta los anulados por defecto', async () => {
      await service.findAll();

      expect(prisma.sectorParque.findMany.mock.calls[0][0].where).toEqual({ anulado: false });
    });

    it('los incluye cuando se piden', async () => {
      await service.findAll(true);

      expect(prisma.sectorParque.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('devuelve 404 si el sector no existe', async () => {
      prisma.sectorParque.findUnique.mockResolvedValue(null);

      await expect(service.findOne(99)).rejects.toThrow(NotFoundException);
    });
  });
});
