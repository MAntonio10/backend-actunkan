import { BitacoraService } from '../bitacora/bitacora.service';
import { getFechaUTC6 } from '../common/utils/date.util';

/**
 * Cierra automáticamente los lotes offline que ya vencieron.
 *
 * ## Por qué existe
 *
 * Un lote vencido queda en un limbo: el dispositivo ya no lo usa —al día siguiente
 * reserva otro— pero sigue en `ACTIVO`. Como el cierre de caja exige que no haya
 * lotes activos, esa caja quedaría **imposible de cerrar**, esperando que alguien
 * concilie un lote que nadie va a conciliar. Y como solo puede haber una caja
 * abierta en todo el sistema, eso bloquearía la operación entera.
 *
 * No se puede exigir que el frontend concilie el lote anterior: cuando el
 * taquillero abre la aplicación al día siguiente, el lote viejo puede ni siquiera
 * estar en el dispositivo (se reinstaló, se borró el almacenamiento, es otro
 * aparato). El backend tiene que poder resolverlo solo.
 *
 * ## Qué implica
 *
 * Los folios sin vender pasan a `NO_UTILIZADO`, así que **una venta que el
 * dispositivo no haya subido antes del vencimiento ya no se puede subir**. Es
 * inevitable: después del cierre el arqueo queda congelado y esa venta no podría
 * contarse en ninguna caja sin corromper un arqueo ya guardado. Por eso el lote
 * vence al final de la jornada y no antes, y por eso queda registrado en Bitácora.
 */
export async function conciliarLotesVencidos(
  tx: any,
  lotes: any[],
  contexto: { idUsuario?: number; usuarioNombre?: string; motivo: string },
): Promise<Array<{ idLote: number; foliosNoUtilizados: number }>> {
  const resultados: Array<{ idLote: number; foliosNoUtilizados: number }> = [];

  for (const lote of lotes) {
    const foliosNoUtilizados = await tx.folioReservado.count({
      where: { idLote: lote.id, estado: 'RESERVADO' },
    });

    await tx.folioReservado.updateMany({
      where: { idLote: lote.id, estado: 'RESERVADO' },
      data: { estado: 'NO_UTILIZADO' },
    });

    await tx.loteOffline.update({
      where: { id: lote.id },
      data: { estado: 'CONCILIADO', fechaConciliacion: getFechaUTC6() },
    });

    await BitacoraService.registrarEnTransaccion(tx, {
      idUsuario: contexto.idUsuario,
      usuarioNombre: contexto.usuarioNombre,
      accion: 'CONCILIAR_LOTE_OFFLINE_VENCIDO',
      modulo: 'Tickets',
      descripcion:
        `Se concilió automáticamente el lote offline ${lote.id} (vencido el ` +
        `${lote.expiraEn.toISOString()}): ${foliosNoUtilizados} folios quedaron sin utilizar. ` +
        `Motivo: ${contexto.motivo}.`,
    });

    resultados.push({ idLote: lote.id, foliosNoUtilizados });
  }

  return resultados;
}
