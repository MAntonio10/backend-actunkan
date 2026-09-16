import { DefinicionReporte } from '../contratos';

import { ventasResumen } from './tickets/ventas-resumen.definicion';
import { ventasPorVendedor } from './tickets/ventas-por-vendedor.definicion';
import { ventasPorAtraccion } from './tickets/ventas-por-atraccion.definicion';
import { ventasPorTipoDeVisitante } from './tickets/ventas-por-tipo-visitante.definicion';
import { ventasPorOrigen } from './tickets/ventas-por-origen.definicion';
import { ventasPorFormaDePago } from './tickets/ventas-por-forma-pago.definicion';
import { ventasDetalle } from './tickets/ventas-detalle.definicion';
import { ticketsAnulados } from './tickets/tickets-anulados.definicion';
import { ventasAMedida } from './tickets/ventas-a-medida.definicion';

import { cajasTurnos } from './cajas/cajas-turnos.definicion';
import { arqueoDeCaja } from './cajas/arqueo-de-caja.definicion';

import { donacionesResumen } from './donaciones/donaciones-resumen.definicion';
import { donacionesDetalle } from './donaciones/donaciones-detalle.definicion';

import { bitacoraDetalle } from './bitacora/bitacora-detalle.definicion';
import { bitacoraResumen } from './bitacora/bitacora-resumen.definicion';

import { usuariosListado } from './usuarios/usuarios-listado.definicion';
import { usuariosPermisos } from './usuarios/usuarios-permisos.definicion';

import { actividadesListado } from './actividades/actividades-listado.definicion';
import { actividadesPorSector } from './actividades/actividades-por-sector.definicion';

/**
 * Catálogo de reportes predeterminados.
 *
 * De aquí salen tres cosas a la vez, y por eso no pueden desincronizarse: las rutas que
 * acepta el controlador, el listado que consume el frontend para pintar sus botones, y la
 * descripción que se le manda a la IA. Agregar un reporte es un archivo nuevo y una línea
 * en esta lista; la IA lo aprende sin que nadie toque el prompt.
 *
 * **Ninguna de estas definiciones llama a la IA.** La IA solo interviene en
 * `POST /reportes/interpretar`, y lo único que hace ahí es elegir cuál de estas
 * definiciones ejecutar y con qué filtros.
 */
const DEFINICIONES: DefinicionReporte[] = [
  // Tickets
  ventasResumen,
  ventasPorVendedor,
  ventasPorAtraccion,
  ventasPorTipoDeVisitante,
  ventasPorOrigen,
  ventasPorFormaDePago,
  ventasDetalle,
  ticketsAnulados,
  // El único sin forma fija: agrupa por lo que se le pida. Va al final de los de
  // tickets para que la IA prefiera los específicos cuando alguno encaje.
  ventasAMedida,
  // Cajas
  cajasTurnos,
  arqueoDeCaja,
  // Donaciones
  donacionesResumen,
  donacionesDetalle,
  // Bitácora
  bitacoraDetalle,
  bitacoraResumen,
  // Usuarios
  usuariosListado,
  usuariosPermisos,
  // Actividades
  actividadesListado,
  actividadesPorSector,
];

// Una clave repetida dejaría un reporte inalcanzable de forma silenciosa: el Map se
// quedaría con el último y el otro simplemente no respondería nunca.
const repetidas = DEFINICIONES.map((d) => d.clave).filter(
  (clave, indice, todas) => todas.indexOf(clave) !== indice,
);
if (repetidas.length > 0) {
  throw new Error(
    `Hay claves de reporte repetidas en el catálogo: ${repetidas.join(', ')}.`,
  );
}

export const REGISTRO_REPORTES: ReadonlyMap<string, DefinicionReporte> =
  new Map(DEFINICIONES.map((definicion) => [definicion.clave, definicion]));

export const CLAVES_REPORTE: readonly string[] = DEFINICIONES.map(
  (d) => d.clave,
);

export function obtenerDefinicion(
  clave: string,
): DefinicionReporte | undefined {
  return REGISTRO_REPORTES.get(clave);
}
