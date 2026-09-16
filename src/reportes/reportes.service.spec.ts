import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BitacoraService } from '../bitacora/bitacora.service';
import { CajasService } from '../cajas/cajas.service';
import { PrismaService } from '../prisma/prisma.service';
import { EspecificacionReporte } from './contratos';
import { REGISTRO_REPORTES } from './definiciones';
import { ReportesService } from './reportes.service';
import { ResolutorFiltrosService } from './resolutor-filtros.service';

describe('ReportesService', () => {
  let servicio: ReportesService;
  let prisma: any;
  let cajas: any;
  let bitacora: any;
  let resolutor: any;

  const EJECUTOR = { id: 7, email: 'cajero@actunkan.gt' };

  const FILTROS_RESUELTOS = {
    desde: new Date('2026-08-01T00:00:00.000Z'),
    hasta: new Date('2026-09-01T00:00:00.000Z'),
    desdeIso: '2026-08-01',
    hastaIso: '2026-08-31',
    etiquetaPeriodo: '1 al 31 de agosto de 2026',
    aplicados: [],
  };

  beforeEach(async () => {
    prisma = {
      permisos: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      usuario: {
        findUnique: jest.fn().mockResolvedValue({ nombre: 'Ana Cajera' }),
      },
    };
    cajas = { esSupervisor: jest.fn().mockResolvedValue(false) };
    bitacora = { registrar: jest.fn().mockResolvedValue({}) };
    resolutor = {
      resolver: jest.fn().mockResolvedValue({ ...FILTROS_RESUELTOS }),
    };

    const modulo = await Test.createTestingModule({
      providers: [
        ReportesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CajasService, useValue: cajas },
        { provide: BitacoraService, useValue: bitacora },
        { provide: ResolutorFiltrosService, useValue: resolutor },
      ],
    }).compile();

    servicio = modulo.get(ReportesService);
  });

  afterEach(() => jest.restoreAllMocks());

  /** Sustituye el `ejecutar` de un reporte real para no tocar la base. */
  function simularEjecucion(
    clave: string,
    especificacion: EspecificacionReporte,
  ) {
    const definicion = REGISTRO_REPORTES.get(clave)!;
    return jest.spyOn(definicion, 'ejecutar').mockResolvedValue(especificacion);
  }

  const ESPECIFICACION_CON_ARQUEO: EspecificacionReporte = {
    titulo: 'Turnos de caja',
    filtrosAplicados: [],
    kpis: [
      { etiqueta: 'Turnos', valor: '3' },
      {
        etiqueta: 'Diferencia acumulada',
        valor: 'Q-25.00',
        soloSupervisor: true,
      },
    ],
    secciones: [
      {
        columnas: [
          { clave: 'cajero', titulo: 'Cajero', formato: 'texto' },
          {
            clave: 'montoContado',
            titulo: 'Contado',
            formato: 'moneda',
            total: 'suma',
          },
          {
            clave: 'montoEsperado',
            titulo: 'Esperado',
            formato: 'moneda',
            total: 'suma',
            soloSupervisor: true,
          },
          {
            clave: 'diferencia',
            titulo: 'Diferencia',
            formato: 'moneda',
            soloSupervisor: true,
          },
        ],
        filas: [
          {
            cajero: 'Ana',
            montoContado: '500.0000',
            montoEsperado: '525.0000',
            diferencia: '-25.0000',
          },
        ],
        totales: { montoContado: '500.0000', montoEsperado: '525.0000' },
      },
    ],
    orientacion: 'horizontal',
  };

  describe('depuración de columnas de supervisión', () => {
    /**
     * La aserción más importante del archivo.
     *
     * Quien cuenta el efectivo no debe conocer el monto esperado: si lo supiera, bastaría
     * teclear esa cifra para que ningún faltante saliera nunca a la luz. No basta con no
     * dibujar la columna — hay que borrar el dato, porque el mismo objeto se serializa a
     * JSON y se escribe dentro del .xlsx.
     */
    it('borra la clave del objeto fila, no solo la columna', async () => {
      simularEjecucion('cajas-turnos', ESPECIFICACION_CON_ARQUEO);

      const reporte = await servicio.generar(
        'cajas-turnos',
        {},
        EJECUTOR,
        'json',
      );
      const fila = reporte.secciones[0].filas[0];

      expect(Object.keys(fila)).not.toContain('montoEsperado');
      expect(Object.keys(fila)).not.toContain('diferencia');
      expect(Object.keys(fila)).toContain('montoContado');
      expect(JSON.stringify(reporte)).not.toContain('525.0000');
    });

    it('borra también las columnas, los totales y los KPIs de supervisión', async () => {
      simularEjecucion('cajas-turnos', ESPECIFICACION_CON_ARQUEO);

      const reporte = await servicio.generar(
        'cajas-turnos',
        {},
        EJECUTOR,
        'json',
      );

      expect(reporte.secciones[0].columnas.map((c) => c.clave)).toEqual([
        'cajero',
        'montoContado',
      ]);
      expect(Object.keys(reporte.secciones[0].totales!)).not.toContain(
        'montoEsperado',
      );
      expect(reporte.kpis.map((k) => k.etiqueta)).not.toContain(
        'Diferencia acumulada',
      );
    });

    it('deja pasar todo cuando quien pide es supervisor', async () => {
      cajas.esSupervisor.mockResolvedValue(true);
      simularEjecucion('cajas-turnos', ESPECIFICACION_CON_ARQUEO);

      const reporte = await servicio.generar(
        'cajas-turnos',
        {},
        EJECUTOR,
        'json',
      );

      expect(reporte.secciones[0].filas[0].montoEsperado).toBe('525.0000');
      expect(reporte.kpis).toHaveLength(2);
    });
  });

  describe('permisos', () => {
    /**
     * `Reportes.Ver` abre el módulo, no los datos. Sin esta comprobación, dársela a un
     * cajero le entregaría de golpe la bitácora, la matriz de permisos y las donaciones.
     */
    it('rechaza el reporte si falta el permiso del módulo dueño de los datos', async () => {
      prisma.permisos.findFirst.mockResolvedValue(null);

      await expect(
        servicio.generar('bitacora-detalle', {}, EJECUTOR, 'json'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('exige que el permiso comprobado sea el del módulo de la definición', async () => {
      simularEjecucion('bitacora-detalle', {
        titulo: 'Bitácora',
        filtrosAplicados: [],
        kpis: [],
        secciones: [],
        orientacion: 'horizontal',
      });

      await servicio.generar('bitacora-detalle', {}, EJECUTOR, 'json');

      expect(prisma.permisos.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            idUsuario: EJECUTOR.id,
            moduloAccion: expect.objectContaining({
              modulo: { nombre: 'Bitacora', anulado: false },
              accion: { nombre: 'Ver' },
            }),
          }),
        }),
      );
    });

    it('rechaza un reporte de supervisión a quien no lo es', async () => {
      cajas.esSupervisor.mockResolvedValue(false);

      await expect(
        servicio.generar('arqueo-de-caja', {}, EJECUTOR, 'json'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('responde 404 con la lista de reportes cuando la clave no existe', async () => {
      await expect(
        servicio.generar('ventas-inventadas', {}, EJECUTOR, 'json'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('catálogo', () => {
    it('oculta los reportes cuyo módulo el usuario no puede ver', async () => {
      // Solo tiene permiso sobre EmisionTickets.
      prisma.permisos.findFirst.mockImplementation((consulta: any) =>
        consulta.where.moduloAccion.modulo.nombre === 'EmisionTickets'
          ? Promise.resolve({ id: 1 })
          : Promise.resolve(null),
      );

      const { datos } = await servicio.listarCatalogo(EJECUTOR);

      expect(datos.length).toBeGreaterThan(0);
      expect(datos.every((r: any) => r.moduloOrigen === 'EmisionTickets')).toBe(
        true,
      );
    });

    it('oculta los reportes de supervisión a quien no lo es', async () => {
      const { datos } = await servicio.listarCatalogo(EJECUTOR);
      expect(datos.map((r: any) => r.clave)).not.toContain('arqueo-de-caja');
    });

    /**
     * `clave` nombra el control del formulario; `parametros`, la query string. El rango
     * de fechas es el único caso donde no coinciden, y sin esta traducción un formulario
     * genérico mandaría `periodo=...` y se llevaría un 400.
     */
    it('dice qué parámetros de query string corresponden a cada filtro', async () => {
      const { datos } = await servicio.listarCatalogo(EJECUTOR);
      const reporte = datos.find((r: any) => r.clave === 'ventas-por-vendedor') as any;

      const periodo = reporte.filtros.find((f: any) => f.tipo === 'rangoFechas');
      expect(periodo.parametros).toEqual(['desde', 'hasta']);

      const vendedor = reporte.filtros.find((f: any) => f.clave === 'vendedor');
      expect(vendedor.parametros).toEqual(['vendedor']);
    });
  });

  describe('bitácora', () => {
    it('registra quién generó qué reporte y en qué formato', async () => {
      simularEjecucion('ventas-resumen', {
        titulo: 'Resumen de ventas',
        filtrosAplicados: [],
        kpis: [],
        secciones: [],
        orientacion: 'vertical',
      });

      await servicio.generar('ventas-resumen', {}, EJECUTOR, 'excel');

      expect(bitacora.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          idUsuario: EJECUTOR.id,
          modulo: 'Reportes',
          accion: 'EXPORTAR_REPORTE',
          descripcion: expect.stringContaining('ventas-resumen'),
        }),
      );
    });

    /** Que falle la auditoría no puede dejar al usuario sin su reporte. */
    it('entrega el reporte aunque la bitácora falle', async () => {
      bitacora.registrar.mockRejectedValue(new Error('base caída'));
      simularEjecucion('ventas-resumen', {
        titulo: 'Resumen de ventas',
        filtrosAplicados: [],
        kpis: [],
        secciones: [],
        orientacion: 'vertical',
      });

      await expect(
        servicio.generar('ventas-resumen', {}, EJECUTOR, 'json'),
      ).resolves.toMatchObject({
        clave: 'ventas-resumen',
      });
    });
  });

  describe('tope de filas', () => {
    it('da a Excel un tope mucho mayor que a PDF', async () => {
      const espia = simularEjecucion('ventas-detalle', {
        titulo: 'Detalle',
        filtrosAplicados: [],
        kpis: [],
        secciones: [],
        orientacion: 'horizontal',
      });

      await servicio.generar('ventas-detalle', {}, EJECUTOR, 'pdf');
      const limitePdf = espia.mock.calls[0][0].limiteFilas;

      await servicio.generar('ventas-detalle', {}, EJECUTOR, 'excel');
      const limiteExcel = espia.mock.calls[1][0].limiteFilas;

      expect(limiteExcel).toBeGreaterThan(limitePdf);
    });

    it('marca el reporte como truncado y lo dice en las notas', async () => {
      simularEjecucion('ventas-detalle', {
        titulo: 'Detalle',
        filtrosAplicados: [],
        kpis: [],
        secciones: [
          {
            columnas: [{ clave: 'folio', titulo: 'Folio', formato: 'texto' }],
            filas: [{ folio: 'TCK-1' }],
            filasDisponibles: 84_312,
          },
        ],
        orientacion: 'horizontal',
      });

      const reporte = await servicio.generar(
        'ventas-detalle',
        {},
        EJECUTOR,
        'pdf',
      );

      expect(reporte.truncado).toBe(true);
      expect(reporte.notas?.[0]).toMatch(/84,?312/);
    });
  });
});
