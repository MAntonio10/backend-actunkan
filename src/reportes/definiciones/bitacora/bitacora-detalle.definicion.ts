import { DefinicionReporte, FilaReporte } from '../../contratos';
import {
  FILTRO_PERIODO,
  FILTRO_VENDEDOR,
  fechaHora,
  kpiEntero,
  periodoDe,
  recortar,
} from '../comunes';

const COLUMNAS = [
  {
    clave: 'fecha',
    titulo: 'Fecha',
    formato: 'fechaHora' as const,
    anchoMinimo: 100,
  },
  {
    clave: 'usuario',
    titulo: 'Usuario',
    formato: 'texto' as const,
    ancho: 0.16,
  },
  { clave: 'modulo', titulo: 'Módulo', formato: 'texto' as const, ancho: 0.12 },
  { clave: 'accion', titulo: 'Acción', formato: 'texto' as const, ancho: 0.16 },
  {
    clave: 'descripcion',
    titulo: 'Descripción',
    formato: 'texto' as const,
    ancho: 0.4,
  },
];

/**
 * El registro de auditoría, un renglón por acción.
 *
 * Es el único reporte que selecciona `Bitacora.descripcion`, que es `NVARCHAR(Max)`: las
 * lecturas LOB fuera de fila son caras y no tienen sentido en un agregado. El resumen
 * hermano no la toca.
 */
export const bitacoraDetalle: DefinicionReporte = {
  clave: 'bitacora-detalle',
  titulo: 'Bitácora de auditoría',
  descripcion:
    'Registro cronológico de las acciones realizadas en el sistema durante el período: ' +
    'fecha, usuario, módulo, acción y descripción de lo que se hizo. Se puede filtrar por ' +
    'usuario, por módulo o por tipo de acción. Sirve para auditar, rastrear cambios o ' +
    'saber quién hizo qué y cuándo.',
  categoria: 'Bitácora',
  moduloOrigen: 'Bitacora',
  orientacionSugerida: 'horizontal',
  filtros: [
    FILTRO_PERIODO,
    {
      ...FILTRO_VENDEDOR,
      etiqueta: 'Usuario',
      descripcion: 'Usuario que ejecutó la acción.',
    },
    {
      clave: 'modulo',
      etiqueta: 'Módulo',
      tipo: 'modulo',
      descripcion:
        'Módulo del sistema donde ocurrió la acción: EmisionTickets, Cajas, Donaciones, ' +
        'Usuarios, ActividadesParque, Bitacora o Reportes.',
    },
    {
      clave: 'accion',
      etiqueta: 'Acción',
      tipo: 'accion',
      descripcion:
        'Tipo de acción registrada, en mayúsculas y con guiones bajos, por ejemplo ' +
        'EMITIR_TICKET, ANULAR_DONACION, INICIO_SESION o APERTURA_CAJA.',
    },
  ],

  async ejecutar({ prisma, filtros, limiteFilas }) {
    const registros = await prisma.bitacora.findMany({
      where: {
        fecha: { gte: filtros.desde, lt: filtros.hasta },
        ...(filtros.idUsuario ? { idUsuario: filtros.idUsuario } : {}),
        ...(filtros.modulo ? { modulo: { contains: filtros.modulo } } : {}),
        ...(filtros.accion ? { accion: { contains: filtros.accion } } : {}),
      },
      orderBy: { fecha: 'desc' },
      take: limiteFilas + 1,
      select: {
        fecha: true,
        usuarioNombre: true,
        modulo: true,
        accion: true,
        descripcion: true,
        usuario: { select: { nombre: true } },
      },
    });

    const { filas: pagina, disponibles } = recortar(registros, limiteFilas);

    const filas: FilaReporte[] = pagina.map((registro) => ({
      fecha: fechaHora(registro.fecha),
      // Se prefiere el nombre congelado en la fila: si el usuario se dio de baja o
      // cambió de nombre, la bitácora debe seguir diciendo quién era entonces.
      usuario: registro.usuarioNombre ?? registro.usuario?.nombre ?? 'Sistema',
      modulo: registro.modulo,
      accion: registro.accion,
      descripcion: registro.descripcion,
    }));

    const usuariosDistintos = new Set(filas.map((fila) => fila.usuario)).size;

    return {
      titulo: 'Bitácora de auditoría',
      periodo: periodoDe(filtros),
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiEntero('Registros', disponibles),
        kpiEntero('Usuarios distintos', usuariosDistintos),
      ],
      secciones: [
        {
          columnas: COLUMNAS,
          filas,
          filasDisponibles: disponibles,
        },
      ],
      orientacion: 'horizontal',
      notas: [
        'El nombre de usuario es el que tenía al momento de la acción: la bitácora lo ' +
          'guarda congelado para que una baja posterior no borre el rastro.',
        'Las acciones del sistema sin usuario identificado aparecen como "Sistema".',
      ],
    };
  },
};
