import {
  ColumnaReporte,
  DefinicionReporte,
  FilaReporte,
} from '../../contratos';
import { kpiEntero } from '../comunes';

/** Orden en que se leen las acciones dentro de una celda. */
const ORDEN_ACCIONES = ['Ver', 'Crear', 'Editar', 'Anular', 'Exportar'];

/** Iniciales de cada acción: la matriz cabe en una página solo así. */
const INICIAL: Record<string, string> = {
  Ver: 'V',
  Crear: 'C',
  Editar: 'E',
  Anular: 'A',
  Exportar: 'X',
};

/**
 * Matriz de permisos: una fila por usuario, una columna por módulo.
 *
 * Es el documento que se revisa en una auditoría de accesos, y hasta ahora había que
 * armarlo a mano consultando usuario por usuario.
 *
 * Las columnas se descubren de la base en vez de estar escritas aquí: si mañana se
 * agrega un módulo, el reporte lo muestra sin que nadie toque este archivo.
 */
export const usuariosPermisos: DefinicionReporte = {
  clave: 'usuarios-permisos',
  titulo: 'Matriz de permisos',
  descripcion:
    'Qué puede hacer cada usuario en cada módulo del sistema, en forma de matriz: una ' +
    'fila por usuario y una columna por módulo, con las acciones concedidas. Responde a ' +
    'preguntas sobre permisos, accesos, privilegios o quién puede hacer qué.',
  categoria: 'Usuarios',
  moduloOrigen: 'Usuarios',
  orientacionSugerida: 'horizontal',
  filtros: [
    {
      clave: 'incluirAnulados',
      etiqueta: 'Incluir dados de baja',
      tipo: 'booleano',
      descripcion:
        'Si se incluyen los usuarios anulados. Por omisión solo los activos.',
    },
  ],

  async ejecutar({ prisma, filtros }) {
    const [modulos, usuarios] = await Promise.all([
      prisma.modulo.findMany({
        where: { anulado: false, esAsignable: true },
        orderBy: { nombre: 'asc' },
        select: { id: true, nombre: true },
      }),
      prisma.usuario.findMany({
        where: filtros.incluirAnulados ? {} : { anulado: false },
        orderBy: [{ anulado: 'asc' }, { nombre: 'asc' }],
        select: {
          id: true,
          nombre: true,
          anulado: true,
          puesto: { select: { nombre: true } },
          permiso: {
            select: {
              moduloAccion: {
                select: {
                  modulo: { select: { nombre: true } },
                  accion: { select: { nombre: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const columnas: ColumnaReporte[] = [
      { clave: 'usuario', titulo: 'Usuario', formato: 'texto', ancho: 0.18 },
      { clave: 'puesto', titulo: 'Puesto', formato: 'texto', ancho: 0.12 },
      ...modulos.map((modulo): ColumnaReporte => ({
        clave: `modulo_${modulo.id}`,
        titulo: modulo.nombre,
        formato: 'texto',
        alineacion: 'centro',
        anchoMinimo: 62,
      })),
    ];

    const porNombre = new Map(
      modulos.map((modulo) => [modulo.nombre, `modulo_${modulo.id}`]),
    );

    const filas: FilaReporte[] = usuarios.map((usuario) => {
      const acciones = new Map<string, Set<string>>();

      for (const permiso of usuario.permiso) {
        const clave = porNombre.get(permiso.moduloAccion.modulo.nombre);
        // Un permiso sobre un módulo anulado o de infraestructura no tiene columna:
        // se ignora en vez de inventarle una, que es lo que hace la pantalla de permisos.
        if (!clave) continue;
        if (!acciones.has(clave)) acciones.set(clave, new Set());
        acciones.get(clave)!.add(permiso.moduloAccion.accion.nombre);
      }

      const fila: FilaReporte = {
        usuario: usuario.anulado ? `${usuario.nombre} (baja)` : usuario.nombre,
        puesto: usuario.puesto?.nombre ?? null,
      };

      for (const modulo of modulos) {
        const clave = `modulo_${modulo.id}`;
        const concedidas = acciones.get(clave);
        fila[clave] = concedidas
          ? ORDEN_ACCIONES.filter((accion) => concedidas.has(accion))
              .map((accion) => INICIAL[accion] ?? accion)
              .join(' ')
          : null;
      }

      return fila;
    });

    const sinPermisos = filas.filter((fila) =>
      modulos.every((modulo) => fila[`modulo_${modulo.id}`] === null),
    ).length;

    return {
      titulo: 'Matriz de permisos',
      subtitulo: 'V = Ver · C = Crear · E = Editar · A = Anular · X = Exportar',
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiEntero('Usuarios', filas.length),
        kpiEntero('Módulos asignables', modulos.length),
        kpiEntero('Sin ningún permiso', sinPermisos),
      ],
      secciones: [{ columnas, filas }],
      orientacion: 'horizontal',
      notas: [
        'Solo se listan los módulos asignables. Los de infraestructura no se conceden a ' +
          'ningún usuario y por eso no tienen columna.',
        'Una celda vacía significa que el usuario no tiene ninguna acción sobre ese módulo.',
        'En Actividades del Parque, editar y anular quedan además reservados al autor de ' +
          'cada publicación: tener la acción no habilita tocar lo ajeno.',
      ],
    };
  },
};
