import { SetMetadata } from '@nestjs/common';

export const PERMITE_USUARIO_ANULADO_KEY = 'permiteUsuarioAnulado';

/**
 * Deja pasar a un usuario dado de baja **solo** en este handler.
 *
 * Existe por una razón concreta: un taquillero al que dan de baja mientras su
 * dispositivo está sin conexión tiene ventas ya cobradas en la cola. Sin esto,
 * `JwtAuthGuard` lo rechaza con `401` al reconectar, esas ventas nunca se
 * registran, y la caja queda con dinero que ningún ticket respalda.
 *
 * **Baja no es repudio de lo actuado.** Las ventas ocurrieron mientras la sesión
 * era legítima; impedir que se registren no las deshace, solo las esconde.
 *
 * Por eso el alcance es mínimo y explícito por handler: se marca únicamente lo
 * que sirve para **liquidar lo ya vendido**, nunca para seguir operando. Un
 * usuario anulado no puede reservar folios nuevos ni recuperar folios
 * pre-firmados. Toda operación suya queda destacada en Bitácora.
 *
 * Ver `ESPECIFICACION_OFFLINE.md` § 11.1.
 */
export const PermiteUsuarioAnulado = () => SetMetadata(PERMITE_USUARIO_ANULADO_KEY, true);
