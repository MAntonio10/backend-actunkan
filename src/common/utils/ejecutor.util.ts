/** Usuario que ejecuta una operación; se registra en la bitácora. */
export interface EjecutorInfo {
  id: number;
  email?: string;
}

/**
 * Normaliza el usuario autenticado que adjunta JwtAuthGuard en `request.user`.
 * Algunos flujos exponen el payload crudo del JWT (`sub`) y otros el registro
 * completo del usuario (`id`), por eso se contemplan ambos.
 */
export function obtenerEjecutor(req: any): EjecutorInfo | undefined {
  if (!req?.user) return undefined;
  return {
    id: req.user.sub ?? req.user.id,
    email: req.user.email ?? req.user.correo,
  };
}
