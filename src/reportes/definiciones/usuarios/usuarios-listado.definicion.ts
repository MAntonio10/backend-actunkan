import { DefinicionReporte, FilaReporte } from '../../contratos';
import { fechaHora, kpiEntero, soloFecha } from '../comunes';

const COLUMNAS = [
  { clave: 'nombre', titulo: 'Nombre', formato: 'texto' as const, ancho: 0.24 },
  { clave: 'correo', titulo: 'Correo', formato: 'texto' as const, ancho: 0.24 },
  {
    clave: 'telefono',
    titulo: 'Teléfono',
    formato: 'texto' as const,
    anchoMinimo: 80,
  },
  { clave: 'puesto', titulo: 'Puesto', formato: 'texto' as const, ancho: 0.16 },
  {
    clave: 'estado',
    titulo: 'Estado',
    formato: 'texto' as const,
    anchoMinimo: 60,
  },
  { clave: 'alta', titulo: 'Alta', formato: 'fecha' as const, anchoMinimo: 70 },
  {
    clave: 'ultimoAcceso',
    titulo: 'Último acceso',
    formato: 'fechaHora' as const,
    anchoMinimo: 100,
  },
];

/**
 * Padrón de usuarios del sistema.
 *
 * Nunca selecciona `contrasena` ni `codigoRestablecimiento`: no hay reporte que los
 * necesite, y la única forma de que no se filtren es no leerlos.
 *
 * El último acceso sale de la sesión de refresco más reciente, que es el registro que de
 * verdad indica actividad; `Usuario` no guarda esa marca.
 */
export const usuariosListado: DefinicionReporte = {
  clave: 'usuarios-listado',
  titulo: 'Usuarios del sistema',
  descripcion:
    'Padrón de usuarios con su puesto, correo, teléfono, si están activos o dados de ' +
    'baja, cuándo se dieron de alta y cuándo accedieron por última vez. Responde a ' +
    'preguntas sobre personal, cuentas, empleados o quién tiene acceso al sistema.',
  categoria: 'Usuarios',
  moduloOrigen: 'Usuarios',
  orientacionSugerida: 'horizontal',
  filtros: [
    {
      clave: 'incluirAnulados',
      etiqueta: 'Incluir dados de baja',
      tipo: 'booleano',
      descripcion:
        'Si se incluyen los usuarios anulados. Por omisión solo se listan los activos.',
    },
  ],

  async ejecutar({ prisma, filtros }) {
    const usuarios = await prisma.usuario.findMany({
      where: filtros.incluirAnulados ? {} : { anulado: false },
      orderBy: [{ anulado: 'asc' }, { nombre: 'asc' }],
      select: {
        id: true,
        nombre: true,
        correo: true,
        telefono: true,
        anulado: true,
        fechaCreacion: true,
        puesto: { select: { nombre: true } },
        sesiones: {
          where: { revocada: false },
          orderBy: { fechaUltimoUso: 'desc' },
          take: 1,
          select: { fechaUltimoUso: true, fechaCreacion: true },
        },
      },
    });

    const filas: FilaReporte[] = usuarios.map((usuario) => {
      const sesion = usuario.sesiones[0];
      return {
        nombre: usuario.nombre,
        correo: usuario.correo,
        telefono: usuario.telefono,
        puesto: usuario.puesto?.nombre ?? null,
        estado: usuario.anulado ? 'Dado de baja' : 'Activo',
        alta: soloFecha(usuario.fechaCreacion),
        // `fechaUltimoUso` es nula hasta que el refresh token se usa una vez; en ese
        // caso el alta de la sesión es lo más cercano a "cuándo entró".
        ultimoAcceso: sesion
          ? fechaHora(sesion.fechaUltimoUso ?? sesion.fechaCreacion)
          : null,
      };
    });

    const activos = filas.filter((fila) => fila.estado === 'Activo').length;

    return {
      titulo: 'Usuarios del sistema',
      filtrosAplicados: filtros.aplicados,
      kpis: [
        kpiEntero('Usuarios', filas.length),
        kpiEntero('Activos', activos),
        kpiEntero('Dados de baja', filas.length - activos),
      ],
      secciones: [{ columnas: COLUMNAS, filas }],
      orientacion: 'horizontal',
      notas: [
        'El último acceso se toma de la sesión activa más reciente. Un usuario sin sesión ' +
          'registrada aparece sin fecha: nunca inició sesión o todas sus sesiones se cerraron.',
        'Un usuario dado de baja conserva su historial y puede seguir apareciendo en los ' +
          'reportes de ventas de fechas anteriores.',
      ],
    };
  },
};
