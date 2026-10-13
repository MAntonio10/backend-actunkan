# Desnormalizaciones deliberadas del esquema

Inventario de columnas que **parecen** violar la 3FN y no la violan. Revisar esta lista antes de proponer cualquier cambio: quitar cualquiera de estas rompe algo que hoy funciona.

Las líneas son de `prisma/schema.prisma`. Verificar que sigan vigentes antes de citarlas.

---

## Valores históricos congelados

Describen el momento en que ocurrió un hecho. Recalcularlos desde el catálogo actual da otra respuesta, y equivocada.

| Columna | Línea | Por qué no es transitiva |
|---|---|---|
| `VisitantePorTicket.precioUnitario` | 224 | Precio que se cobró ese día. `Tarifa` tiene vigencia (`vigenteDesde`/`vigenteHasta`, líneas 308-309): la de hoy puede ser otra. Derivarlo reescribiría el histórico de ventas. |
| `VisitantePorTicket.subtotal` | 225 | Lo cobrado por esa categoría. Mismo motivo. |
| `Ticket.montoTotal` | 161 | Dinero que entró al cajón. Es lo que cuadra contra el arqueo. |
| `Ticket.montoRecalculado` | 187 | Lo que la tarifa decía que debía costar, cuando difiere de lo cobrado. Existe **precisamente** para conservar la diferencia: derivarlo la borraría. |
| `CierreCaja.montoEsperado` | 438 | Calculado al cerrar y congelado. El arqueo es inmutable por diseño. |
| `CierreCaja.diferencia` | 439 | Sobrante o faltante del turno. Recalcularlo con datos posteriores cambiaría un asiento cerrado. |

**Señal para reconocerlos:** la tabla de referencia tiene vigencia, o la fila es un asiento contable que no se toca después.

---

## Copias defensivas para auditoría

| Columna | Línea | Por qué existe |
|---|---|---|
| `Bitacora.usuarioNombre` | 510 | Copia del nombre del ejecutor. La relación `usuario` es `onDelete: SetNull`: si el usuario desaparece, la bitácora **tiene que seguir diciendo quién fue**. Quitarla en nombre de la 3FN destruye el valor probatorio del registro. |

**Señal:** relación opcional o `SetNull`, en una tabla de auditoría. La redundancia *es* el mecanismo de supervivencia.

`Bitacora.modulo` y `Bitacora.accion` son **texto libre**, no claves foráneas a `Modulo` y `Accion`. Parece un candidato a normalizar y no lo es: sus valores no coinciden con esas tablas —la bitácora escribe `Tickets`, `Auth`, `Gastos`, `TiposGasto` y `Modulos`, que no existen como módulo— y varios módulos no tienen ni un registro. Convertirlas en FK exigiría inventar filas para valores históricos y perdería los que no encajen.

---

## Contadores materializados

| Columna | Línea | Por qué no se deriva |
|---|---|---|
| `DispositivoTaquilla.ultimoCorrelativo` | 611 | Mayor folio que la taquilla declaró. |
| `DispositivoTaquilla.foliosRendidos` | 617 | Folios que llegaron, como ticket o como descarte declarado. |
| `Correlativo.ultimoNumero` | 339 | Reserva el siguiente folio bajo transacción `Serializable`. Es un mecanismo de concurrencia, no un caché. |

Los dos primeros parecen derivables contando filas, y ahí está la trampa: **su resta detecta ausencias**. Un folio emitido que nunca llegó no existe como fila que contar, así que derivarlos daría siempre cero y el control desaparecería. Son el único rastro de un cobro que se desvió sin declararse.

`ultimoCorrelativo` además **solo sube**, nunca baja ni se reinicia, y el cliente depende de esa garantía: el dispositivo se queda con el mayor entre su contador local y este, porque el local va legítimamente adelante mientras tenga ventas sin subir. Hay pruebas en `src/dispositivos/dispositivos.service.spec.ts` que fallan si alguien agrega un reinicio.

---

## Patrones que no son violaciones

**Vigencia temporal.** `Tarifa` y `TarifaGuia` usan `vigenteDesde` / `vigenteHasta = null` para marcar la fila activa. Editar un precio no sobrescribe: cierra la vigencia anterior y crea otra fila. Es un diseño temporal correcto, no duplicación.

**Baja lógica.** `anulado Boolean @default(false)` en 21 modelos. No es redundancia: es estado.

**Claves de negocio en texto.** `Ticket.numeroTicket`, `Donacion.numeroRecibo` y los `codigo` de los catálogos son identificadores externos, impresos en papel. Su existencia junto al `id` autoincremental no viola nada.

**Ausencia de `descripcion` en `Modulo`.** No la tiene —`Puestos` sí—. Si alguien propone agregarla, es una decisión de producto, no de normalización.

---

## Cómo ampliar esta lista

Al encontrar una columna redundante **con justificación**, agregarla aquí con:

1. La columna y su línea.
2. Qué se rompería al derivarla, en concreto.
3. La señal que permite reconocer el mismo patrón en otra tabla.

El valor de este archivo está en la tercera: sin ella, la próxima revisión vuelve a discutir lo mismo desde cero.
