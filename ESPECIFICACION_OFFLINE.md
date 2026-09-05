# Especificación backend — Emisión de tickets offline

Contrato que debe implementar el backend para que la taquilla del Parque Regional Municipal
Actún Kan pueda vender tickets sin conexión a internet, entregando al visitante un pase con QR
**válido desde el momento de la venta**.

Documento dirigido a quien implementa el backend. El frontend se construye contra este contrato.

Complementa a `DOCUMENTACION_ENDPOINTS.md`; no lo reemplaza. Las secciones citadas (`11. Tickets`,
`12. Tarifas`, `8. Cajas`) son las de ese documento.

---

## 0. Verificación previa — resuelta

Todo este diseño dependía de una sola suposición:

> **La firma del QR se calcula únicamente sobre `numeroTicket`.**
> `firma = HMAC-SHA256(SECRETO_QR, numeroTicket)`

**Verificado en el código: se cumple.** `firmarNumeroTicket()` (`src/common/utils/qr.util.ts:17-19`)
hace exactamente `createHmac('sha256', secreto).update(numeroTicket)`, sin monto, fecha ni cantidad
de personas. El pre-firmado de folios es viable y no hay que tocar la firma.

Dos consecuencias que conviene tener presentes:

- El secreto sale de `TICKET_QR_SECRET` y, si la variable no está definida, cae a un valor por
  defecto que está escrito en el código (`'aktunkan-ticket-qr-dev'`). Con ese fallback activo,
  cualquiera con acceso al repositorio puede firmar folios válidos. **Confirmar que la variable esté
  definida antes de reservar el primer lote.**
- Si algún día la firma se ampliara a más campos, el pre-firmado deja de funcionar. Vale como nota
  para quien mantenga `qr.util.ts`.

---

## 1. Concepto

Un **folio reservado** es un número de ticket con su firma, generado por el servidor *antes* de que
exista la venta. El servidor lo entrega al dispositivo de taquilla mientras hay conexión. El
dispositivo lo consume después, sin red.

Un **lote** agrupa folios reservados y queda atado a un usuario, un dispositivo y una caja abierta.

Ciclo de vida:

```
                    ┌─── conciliar ──────────> NO_UTILIZADO
                    │
RESERVADO ──────────┼─── expiración ─────────> NO_UTILIZADO
                    │
                    ├─── DELETE del lote ────> INVALIDADO
                    │
                    └─── emitir-offline ─────> EMITIDO ──validar──> EMITIDO + fechaUso
```

**Solo un folio `EMITIDO` autoriza el ingreso.** Un folio `RESERVADO` tiene firma criptográficamente
válida pero no corresponde a ninguna venta: si `/tickets/validar` lo aceptara, sería una entrada
gratis. Ver § 7.

---

## 2. Modelo de datos

### 2.1 Tabla nueva: `LoteOffline`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | int PK | |
| `idUsuario` | int FK | Quien reservó el lote |
| `idAperturaCaja` | int FK | Caja abierta al momento de reservar |
| `idDispositivo` | string | UUID persistente que genera el navegador |
| `estado` | enum | `ACTIVO` \| `CONCILIADO` \| `INVALIDADO` |
| `fechaCreacion` | timestamp | |
| `expiraEn` | timestamp | Ver § 3 |
| `fechaConciliacion` | timestamp? | |

### 2.2 Tabla nueva: `FolioReservado`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | int PK | |
| `idLote` | int FK | |
| `numeroTicket` | string UNIQUE | |
| `firma` | string | |
| `estado` | enum | `RESERVADO` \| `EMITIDO` \| `NO_UTILIZADO` \| `INVALIDADO` |
| `idTicket` | int FK? | Se llena al emitir |

> **Tabla aparte, no filas de `Ticket` en estado reservado.** Pre-crear filas en `Ticket` obligaría a
> filtrarlas en `GET /tickets`, en el arqueo, en las métricas y en cualquier consulta futura. Un
> `WHERE` olvidado en un solo sitio mete folios fantasma en un reporte de ingresos. La tabla
> separada no toca ninguna consulta existente.

### 2.3 Campos nuevos en `Ticket`

| Campo | Tipo | Notas |
|---|---|---|
| `idLocal` | uuid? **UNIQUE FILTRADO** | Clave de idempotencia. Null en ventas online. Ver la advertencia de abajo |
| `idLoteOffline` | int FK? | |
| `fechaEmisionOffline` | timestamp? | Momento real de la venta, distinto de `fechaCreacion` |
| `montoRecalculado` | decimal? | Solo si difiere de lo cobrado (§ 5, regla 8) |
| `origenOffline` | boolean | Default `false` |

El índice único sobre `idLocal` es lo que hace segura la reintentabilidad. No es opcional.

> ### ⚠ El índice único de `idLocal` NO se puede declarar con `@unique` de Prisma
>
> **En SQL Server un índice único admite una sola fila con `NULL`.** Como las ventas online llevan
> `idLocal: null`, un `@unique` corriente haría fallar **la segunda venta online del sistema** con
> `Cannot insert duplicate key row … The duplicate key value is (<NULL>)` (error 2601). Comprobado
> contra la base de datos de este proyecto.
>
> Hay que crear un **índice único filtrado**, que Prisma no sabe expresar en el esquema:
>
> ```sql
> CREATE UNIQUE INDEX UX_Ticket_idLocal
>   ON Ticket (idLocal)
>   WHERE idLocal IS NOT NULL;
> ```
>
> Procedimiento: declarar `idLocal String? @db.NVarChar(36)` **sin `@unique`**, aplicar `prisma db
> push`, y crear el índice con SQL crudo. Dejarlo anotado junto a la migración: un `db push`
> posterior no lo recrea, y perderlo elimina en silencio la garantía de idempotencia — los
> reintentos empezarían a duplicar tickets sin que nada falle.

### 2.4 Secuencia de folios

Reservar 100 folios consume 100 números de la secuencia global. Las ventas online que ocurran
mientras tanto toman los números siguientes al bloque.

**La reserva y la emisión online deben tomar números del mismo contador atómico.** Es el error
clásico de este diseño: dos caminos leyendo `MAX(numeroTicket)` por separado generan folios
duplicados bajo concurrencia.

**Ese contador ya existe y hay que reusarlo, no crear uno nuevo.** `generarCorrelativo(tx, serie,
anio)` (`src/common/utils/correlativo.util.ts`) hace un `upsert` con `increment` sobre la tabla
`Correlativo`, y debe llamarse dentro de una transacción `Serializable` — es lo que hoy usan tanto la
emisión de tickets como los recibos de donación. Si la reserva de folios llama a esa misma función,
la unicidad frente a las ventas online queda garantizada por construcción, sin verificaciones
cruzadas contra dos tablas.

> **Los folios reservados dejan huecos permanentes en la numeración.** Un lote de 100 del que se
> venden 12 deja 88 números que nunca corresponderán a un ticket. Es inevitable y por eso § 6 los
> marca `NO_UTILIZADO` en vez de dejarlos sin registro: la auditoría necesita poder explicar cada
> hueco. Refuerza la recomendación de § 3 de pedir lotes chicos y no el máximo de 200 por costumbre.

---

## 3. `POST /tickets/lotes-offline` — Reservar folios

Permiso: `EmisionTickets` / `Crear`

**Request**
```json
{ "cantidad": 100, "idDispositivo": "b3f1c2d4-…" }
```

`cantidad`: entero entre 1 y 200. Lotes chicos limitan el daño si se pierde el dispositivo.

**Reglas**

1. `idAperturaCaja` **no lo envía el cliente**: el servidor toma la caja abierta actual. Si no hay
   caja abierta, `400` — igual que `POST /tickets/emitir`.
2. Si ese `idDispositivo` ya tiene un lote `ACTIVO`, responder `409` con `{ "codigo":
   "LOTE_ACTIVO_EXISTENTE", "idLote": 7 }`. El cliente debe conciliar el anterior primero. Para
   recuperar sus folios está `GET /tickets/lotes-offline/activo`.
3. `expiraEn`: fin de la jornada operativa. Sugerido, configurable: las 06:00 del día siguiente.
   Un job diario pasa los `RESERVADO` vencidos a `NO_UTILIZADO`.

**Response `201`**
```json
{
  "idLote": 7,
  "idAperturaCaja": 12,
  "idUsuario": 3,
  "idDispositivo": "b3f1c2d4-…",
  "estado": "ACTIVO",
  "fechaCreacion": "2026-08-20T13:00:00.000Z",
  "expiraEn": "2026-08-21T06:00:00.000Z",
  "folios": [
    {
      "numeroTicket": "TCK-2026-000101",
      "firma": "9f2a7c…",
      "qr": "{\"numeroTicket\":\"TCK-2026-000101\",\"firma\":\"9f2a7c…\"}"
    }
  ]
}
```

> **`qr` debe venir armado por el servidor**, en el mismo formato exacto que produce hoy
> `TicketBackend.qr` en la emisión online. Si el frontend tuviera que construir esa cadena por su
> cuenta, cualquier cambio futuro de formato rompería silenciosamente los pases offline y el
> problema aparecería recién en la puerta de la cueva.
>
> **El formato real es JSON, no una cadena separada por barras.** `construirPayloadQr()`
> (`src/common/utils/qr.util.ts`) devuelve `JSON.stringify({ numeroTicket, firma })`. La reserva de
> folios debe llamar a esa misma función — no reproducir el formato a mano, que es exactamente el
> error contra el que advierte el párrafo anterior.

---

## 4. `GET /tickets/lotes-offline/activo` — Recuperar lote

Permiso: `EmisionTickets` / `Ver`
Query: `?idDispositivo=b3f1c2d4-…`

Devuelve el lote `ACTIVO` de ese dispositivo con los folios que siguen en `RESERVADO`. Sirve para
cuando se reinstala la aplicación o se borra el almacenamiento local: sin esto, los folios quedan
inutilizables hasta que expiren y el taquillero no puede vender.

Exige que coincidan **usuario y dispositivo**. Este endpoint vuelve a exponer folios pre-firmados;
no debe poder usarse desde otra sesión para extraerlos.

**Response `200`**
```json
{ "hayLoteActivo": true, "lote": { … misma forma que § 3 … } }
```
o `{ "hayLoteActivo": false, "lote": null }`.

Envoltorio explícito, siguiendo el criterio de `GET /cajas/actual`.

---

## 5. `POST /tickets/emitir-offline` — Subir la cola de ventas

Permiso: `EmisionTickets` / `Crear`

**Request** — lote de hasta 50 ventas por llamada.
```json
{
  "idLote": 7,
  "ventas": [
    {
      "idLocal": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "numeroTicket": "TCK-2026-000101",
      "numeroTicketGuia": "TCK-2026-000102",
      "fechaEmision": "2026-08-20T14:32:11.000Z",
      "montoCobrado": "85.00",

      "nombreGrupo": "Familia Rodríguez",
      "idAtraccion": 1,
      "idOrigen": 1,
      "idPais": null,
      "idTipoRecorrido": 1,
      "cantidades": [
        { "idTipoVisitante": 1, "cantidad": 2 },
        { "idTipoVisitante": 2, "cantidad": 3 }
      ],
      "idOpcionPago": 1,
      "notas": "Grupo con reserva previa",
      "guia": { "modo": "nuevo", "nombre": "Pedro Ak'abal", "tieneCarnet": false, "idOpcionPagoGuia": 2 }
    }
  ]
}
```

Todo lo que va después de `montoCobrado` es el payload de `POST /tickets/emitir` sin cambios.

`numeroTicketGuia` solo aparece cuando la venta lleva guía sin carnet, que genera un segundo ticket
y por lo tanto consume un segundo folio.

**Reglas, en este orden**

1. **Idempotencia.** Si `idLocal` ya existe, no crear nada: devolver el ticket existente con estado
   `DUPLICADO_IGNORADO`. Es lo que permite al cliente reintentar sin miedo tras un timeout ambiguo.
2. El folio debe pertenecer a `idLote` y estar en `RESERVADO`. Si no, rechazar ese ítem.
3. `idOpcionPago` debe ser **efectivo**. Offline no se cobra con tarjeta: sin pasarela no hay cobro.
   Cualquier otra forma de pago se rechaza.
4. **Acotar `fechaEmision`** al rango `[lote.fechaCreacion, ahora]`. Viene del reloj del dispositivo
   y no es confiable; un reloj mal puesto mandaría la venta al arqueo de otro día.
5. Recalcular el precio con la **tarifa vigente en `fechaEmision`**. Las tarifas ya son versionadas
   por vigencia (`DOCUMENTACION_ENDPOINTS.md` § 12), así que el dato existe.

   > **Falta escribir la consulta.** Hoy todas las resoluciones de tarifa filtran por
   > `vigenteHasta: null`, es decir la tarifa de hoy y solo esa (`src/tickets/tickets.service.ts`,
   > líneas 104, 247 y 480, y `tarifaGuia` en la 480). Hay que agregar un
   > `resolverTarifaEn(fecha)` que busque `vigenteDesde <= fecha AND (vigenteHasta IS NULL OR
   > vigenteHasta > fecha)`, y usarlo también para `TarifaGuia`. Es trabajo real, no una consulta
   > que ya esté disponible: sin él, una venta offline del día que cambió el precio se recalcula
   > con la tarifa equivocada.
6. Crear el ticket con `numeroTicket` = el folio reservado. Pasar el folio a `EMITIDO`.

   **Un guía nuevo repetido se reutiliza, no se rechaza.** La emisión online resuelve
   `guia: { modo: 'nuevo' }` con `GuiasService.exigirNombreLibre()`, que lanza `409` si el nombre ya
   existe (`src/tickets/tickets.service.ts:180`). Offline es normal que el mismo guía nuevo acompañe
   a varios grupos en el turno: la primera venta lo crearía y **todas las siguientes se rechazarían**.
   En la subida, `modo: 'nuevo'` debe resolverse por nombre — si ya existe un guía activo con ese
   nombre, usarlo; si no, crearlo. Nunca fallar por duplicado. El rechazo de nombres repetidos sigue
   vigente en la emisión online, donde el taquillero sí puede corregir en el momento.
7. **La caja del ticket es `lote.idAperturaCaja`, no la caja abierta al momento de subir.** La venta
   ocurrió en el turno del lote y ahí debe cuadrar.
8. Crear el `TicketPago` en efectivo por **`montoCobrado`**, que es el dinero que realmente entró al
   cajón. Si el recálculo del punto 5 difiere, guardarlo en `montoRecalculado` y exponer la
   diferencia en el arqueo. **No rechazar por discrepancia**: el visitante ya pagó y ya entró; un
   rechazo dejaría dinero en la caja sin ticket que lo respalde, que es peor.

   > **Guardar `montoRecalculado` en `Ticket` no basta: la discrepancia se vuelve invisible.**
   > `calcularArqueo()` suma `TicketPago.monto` (`src/cajas/cajas.service.ts:109-128`), que es
   > justamente `montoCobrado`. El monto esperado va a cuadrar con el efectivo contado y la
   > diferencia no aparece en ningún lado: un taquillero que cobra de menos no deja rastro en el
   > arqueo.
   >
   > `GET /cajas/:id/arqueo` y la respuesta del cierre deben incluir un campo propio, junto a
   > `ventasEfectivo` y `totalDonaciones`:
   >
   > ```json
   > "discrepanciaOffline": { "tickets": 2, "montoCobrado": "150.00", "montoRecalculado": "170.00", "diferencia": "-20.00" }
   > ```
   >
   > Es información de supervisión, así que se oculta al cajero con el mismo criterio que
   > `montoEsperado` (`DOCUMENTACION_ENDPOINTS.md`, «Control de arqueo»): quien cobró de menos no
   > debería ver si el sistema lo detectó.
9. Registrar en Bitácora, marcando origen offline, con `fechaEmision` y fecha de sincronización.

**Cada venta va en su propia transacción.** Una venta con datos malos no debe abortar las otras 49.

**Response `200`** — éxito parcial. Nunca `4xx` para el lote completo si al menos un ítem es válido.
```json
{
  "procesadas": 3,
  "resultados": [
    { "idLocal": "f47ac10b-…", "estado": "CREADO", "ticket": { … TicketBackend … } },
    { "idLocal": "a91bd22c-…", "estado": "DUPLICADO_IGNORADO", "ticket": { … } },
    { "idLocal": "c02ef88a-…", "estado": "RECHAZADO", "codigo": "FOLIO_NO_RESERVADO", "mensaje": "…" }
  ]
}
```

Códigos de rechazo: `FOLIO_NO_RESERVADO`, `FOLIO_YA_EMITIDO`, `FOLIO_DE_OTRO_LOTE`,
`LOTE_INVALIDADO`, `PAGO_NO_EFECTIVO`, `CATALOGO_INVALIDO`.

> `FOLIO_YA_EMITIDO` se separa de `FOLIO_NO_RESERVADO` a propósito: son dos problemas distintos. El
> segundo es un folio que nunca existió o pertenece a otro lote — un error de datos. El primero
> significa que el dispositivo gastó dos veces el mismo folio en ventas distintas, con dos `idLocal`
> diferentes, y por lo tanto **hay una venta cobrada que se va a perder**. Conflagrarlos en un solo
> código haría que el taquillero trate como error de sistema algo que hay que investigar.

El resultado por ítem es lo que le permite al frontend distinguir **"no hubo red, reintento"** de
**"el servidor lo rechazó, aviso al taquillero y no reintento"**. Sin esa distinción, la cola
reintenta para siempre una venta que nunca va a entrar.

---

## 6. `POST /tickets/lotes-offline/:id/conciliar` — Cerrar el lote

Permiso: `EmisionTickets` / `Crear`

**Request** — el cliente declara lo que hizo, como contraste.
```json
{
  "foliosUtilizados": ["TCK-2026-000101", "TCK-2026-000102"],
  "foliosNoUtilizados": ["TCK-2026-000103", "…"]
}
```

**Reglas**

1. Todo folio del lote que siga en `RESERVADO` pasa a `NO_UTILIZADO`. Así la auditoría no ve huecos
   inexplicados en la secuencia de folios.
2. Si el cliente declara utilizado un folio del que el servidor no tiene ticket, **no fallar**:
   agregarlo a `advertencias`. Significa una venta que se perdió (almacenamiento corrupto, cola
   borrada) y hay que investigarla, pero bloquear la conciliación dejaría la caja sin poder cerrar.
3. El lote pasa a `CONCILIADO`. Recién entonces se puede cerrar la caja (§ 8).

**Response `200`**
```json
{
  "idLote": 7,
  "estado": "CONCILIADO",
  "emitidos": 12,
  "noUtilizados": 88,
  "advertencias": [
    { "numeroTicket": "TCK-2026-000140", "detalle": "Declarado utilizado, sin ticket registrado" }
  ]
}
```

---

## 7. `DELETE /tickets/lotes-offline/:id` — Invalidar lote

Permiso: `EmisionTickets` / `Anular`

Para dispositivo perdido o robado. Todos los folios `RESERVADO` pasan a `INVALIDADO`, el lote
también. Las subidas posteriores contra ese lote se rechazan con `LOTE_INVALIDADO`.

> **Destruye las ventas offline que todavía no se hubieran subido.** Ese dinero quedaría cobrado sin
> ticket. Usar solo cuando el dispositivo no va a volver.

---

## 8. Cambio en `POST /tickets/validar`

`DOCUMENTACION_ENDPOINTS.md` § 11.3 hoy responde `200` / `401` / `404` / `409`.

**Regla nueva:** si `numeroTicket` corresponde a un `FolioReservado` en estado `RESERVADO`,
`NO_UTILIZADO` o `INVALIDADO`, responder **`404`**, idéntico a un folio inexistente.

Sin distinguir entre los casos, y sin mensaje que revele que el folio existe. La firma de un folio
reservado es criptográficamente válida; si `/validar` lo aceptara, cualquier folio filtrado sería
entrada gratuita. Y un mensaje del tipo "folio reservado, aún no vendido" le confirma a quien esté
probando números que el rango del bloque existe.

> **Esta regla ya se cumple sola: no hay que escribir código.** `validar()` busca el folio con
> `ticket.findUnique({ where: { numeroTicket } })` (`src/tickets/tickets.service.ts:697`) y responde
> `404` si no lo encuentra. Como los folios reservados viven en `FolioReservado` y no en `Ticket`
> (§ 2.2), un folio aún no vendido no produce ninguna fila que encontrar. La decisión de usar una
> tabla aparte entrega esta sección sin costo.
>
> Lo que sí hay que hacer es **una prueba que lo fije**: reservar un lote, intentar validar uno de
> sus folios con su firma legítima y comprobar que devuelve `404`. Sin esa prueba, alguien que en el
> futuro «optimice» la validación buscando también en `FolioReservado` abriría la puerta a entradas
> gratis sin que nada falle.

---

## 9. Cambio en `POST /cajas/:id/cierre`

Hoy el arqueo es inmutable y solo puede haber una caja abierta en todo el sistema
(`DOCUMENTACION_ENDPOINTS.md` § 8). Una venta offline de las 10:00 que sube a las 16:00 no puede
entrar en una caja cerrada a las 14:00 sin corromper un arqueo ya guardado.

**Regla nueva:** si la caja tiene un lote offline en estado `ACTIVO`, responder `409`.
```json
{ "codigo": "LOTE_OFFLINE_PENDIENTE", "idLote": 7, "foliosReservados": 88 }
```

El taquillero cierra su turno con conexión, que es cuando de todos modos cuenta el efectivo.

**Salida de emergencia:** `POST /cajas/:id/cierre` con `{ "forzarLoteOffline": true }`, que exige
permiso **`Cajas` / `Editar`**. Invalida el lote (§ 7) y lo deja registrado en Bitácora. Las ventas
que lleguen después de eso entran como ajuste post-cierre **visible**, nunca en silencio.

> **El permiso es `Editar`, no `Anular`, y la diferencia importa.** En este sistema `Cajas.Editar`
> representa supervisión: es lo que exige anular un cierre, precisamente para que el cajero no pueda
> cerrar, ver la diferencia, anular y volver a cerrar con la cifra exacta
> (`DOCUMENTACION_ENDPOINTS.md`, «Control de arqueo»). El cajero **sí** tiene `Cajas.Anular` —lo usa
> para anular tickets y aperturas equivocadas—, así que pedir `Anular` acá dejaría en sus manos
> descartar sus propias ventas offline pendientes y cerrar la caja sin ellas. Es exactamente el
> agujero que el modelo de permisos de cajas cierra.

---

## 10. Duración del refresh token

El dispositivo puede pasar un turno completo sin conexión. Al reconectar necesita un refresh token
todavía válido para subir la cola.

**Si el refresh token vence antes de que el dispositivo reconecte, no se puede subir nada** — y el
taquillero tampoco puede volver a iniciar sesión, porque justamente estaba sin internet. Las ventas
quedan atrapadas en el dispositivo.

Recomendación: **mínimo 7 días** para sesiones con `recordarme: true`.

**Verificado: ya se cumple con margen.** Un login con `recordarme: true` emite un refresh de
**30 días** (`DIAS_CON_RECORDARME`, `src/auth/sesiones.service.ts:13`). No hay que cambiar nada.

La rotación de refresh tokens no estorba: es un solo dispositivo, con un solo token en vuelo.

---

## 11. Login offline — qué necesita el backend

**Nada.** Se resuelve entero en el frontend.

En el login online el navegador tiene la contraseña en claro. Deriva
`PBKDF2-SHA256(contraseña, salt aleatorio, 600 000 iteraciones)` con WebCrypto y guarda localmente
solo el salt y el digest; la contraseña nunca se almacena. Esa misma derivación produce además la
llave AES-GCM con la que se cifran, en el almacenamiento local, el refresh token y los folios
pre-firmados. Un dispositivo robado sin la contraseña no entrega folios utilizables.

Se documenta acá solo para que quede constancia de dos límites que sí dependen del backend:

- La duración del refresh token (§ 10) también acota la ventana de login offline.
- **Un usuario dado de baja mientras el dispositivo está offline sigue operando hasta que
  reconecte.** No tiene solución limpia: sin red no hay forma de consultar su estado. Al
  sincronizar se detecta y se cierra la sesión, pero esos tickets ya se vendieron. Conviene que
  Bitácora lo deje explícito al procesar el lote.

### 11.1 El usuario anulado conserva el derecho a sincronizar — sí requiere backend

La afirmación de arriba («al sincronizar se detecta y se cierra la sesión») **no es lo que pasa hoy,
y por eso esta sección sí necesita cambios en el backend.**

`JwtAuthGuard` rechaza con `401` a cualquier usuario con `anulado: true`, antes de llegar al
controlador (`src/auth/guards/jwt-auth.guard.ts:61-65`). Si a un taquillero lo dan de baja mientras
está sin conexión, al reconectar **no puede subir nada**: el dinero ya está en el cajón, los
visitantes ya entraron, y no existe ticket que lo respalde. La caja no cuadra y no hay forma de
arreglarlo salvo tocando la base a mano.

**Regla: un usuario anulado conserva el derecho a liquidar lo que ya vendió, y nada más.**

Baja no es lo mismo que repudio de lo actuado. Las ventas ocurrieron mientras la sesión era
legítima; impedir que se registren no las deshace, solo las esconde.

**Alcance, deliberadamente mínimo.** Un usuario anulado puede llamar únicamente a:

| Endpoint | Por qué |
|---|---|
| `POST /auth/refresh` | Sin token de acceso vigente no puede llamar a nada más |
| `POST /tickets/emitir-offline` | Es el acto de liquidar lo ya vendido |
| `POST /tickets/lotes-offline/:id/conciliar` | Cerrar el lote para que la caja pueda cerrarse |

Todo lo demás sigue devolviendo `401`. En particular **no** puede reservar folios nuevos
(`POST /tickets/lotes-offline`) ni recuperar folios pre-firmados
(`GET /tickets/lotes-offline/activo`): eso sería seguir operando, no liquidar.

**Implementación.**

1. Un decorador `@PermiteUsuarioAnulado()` marca esos handlers. `JwtAuthGuard` deja pasar al usuario
   anulado **solo** si el handler lo declara; en cualquier otro sigue lanzando `401`. Igual que
   `@RequirePermission`, es explícito por handler: nada se habilita por omisión.
2. `POST /auth/refresh`, cuando el usuario está anulado, emite un token de acceso **de alcance
   reducido**, con la marca `soloSincronizacion: true`. El guard rechaza ese token en cualquier
   handler que no esté marcado. Sin esto, refrescar le devolvería acceso completo al sistema y la
   baja no serviría de nada.
3. El derecho está **acotado al lote**: solo se aceptan subidas contra lotes que ya estaban `ACTIVO`
   cuando se anuló al usuario, y mientras no hayan pasado su `expiraEn`. No es una licencia
   indefinida.
4. `PermissionsGuard` sigue aplicando sin cambios. El usuario conserva sus filas en `Permisos`
   —anular no las borra—, así que necesita igual `EmisionTickets` / `Crear`.
5. **Bitácora registra cada operación de un usuario anulado de forma destacada**, con el motivo. Es
   el rastro que le permite al supervisor entender por qué aparecieron tickets de alguien que ya no
   trabaja ahí.

> El escenario que esto habilita es también el que hay que vigilar: alguien recién despedido subiendo
> ventas. Por eso el alcance es mínimo, está atado a un lote preexistente y queda todo en Bitácora.
> La alternativa —perder las ventas— deja un descuadre de caja que nadie puede explicar, que es peor
> y además invisible.

---

## 12. Resumen de cambios

| # | Endpoint | Tipo |
|---|---|---|
| 1 | `POST /tickets/lotes-offline` | Nuevo |
| 2 | `GET /tickets/lotes-offline/activo` | Nuevo |
| 3 | `POST /tickets/emitir-offline` | Nuevo |
| 4 | `POST /tickets/lotes-offline/:id/conciliar` | Nuevo |
| 5 | `DELETE /tickets/lotes-offline/:id` | Nuevo |
| 6 | `POST /tickets/validar` | **Sin cambios** — ya responde 404 (§ 8); agregar prueba que lo fije |
| 7 | `POST /cajas/:id/cierre` | Modificado — 409 con lote activo, más `forzarLoteOffline` (`Cajas.Editar`) |
| 8 | `GET /cajas/:id/arqueo` | Modificado — campo `discrepanciaOffline`, oculto al cajero (§ 5, regla 8) |
| 9 | `POST /auth/refresh` | Modificado — token de alcance reducido para usuario anulado (§ 11.1) |
| 10 | `JwtAuthGuard` | Modificado — decorador `@PermiteUsuarioAnulado()` (§ 11.1) |
| 11 | Refresh token | **Sin cambios** — ya son 30 días con `recordarme` (§ 10) |

**Trabajo interno, sin endpoint propio:**

- `resolverTarifaEn(fecha)` para tarifas y tarifas de guía (§ 5, regla 5). Hoy no existe.
- Resolución de guía nuevo por nombre en la subida, sin rechazar duplicados (§ 5, regla 6).
- Reusar `generarCorrelativo()` en la reserva de folios, no crear un contador nuevo (§ 2.4).
- Reusar `construirPayloadQr()` para armar el campo `qr` (§ 3).

**Migraciones:** tablas `LoteOffline` y `FolioReservado`; campos `idLocal`, `idLoteOffline`,
`fechaEmisionOffline`, `montoRecalculado` y `origenOffline` en `Ticket`.

> El índice único de `idLocal` **debe crearse con SQL crudo y filtrado**
> (`WHERE idLocal IS NOT NULL`); un `@unique` de Prisma rompe la emisión online en SQL Server. Ver
> la advertencia de § 2.3. El contador de folios ya existe (`Correlativo`) y no requiere migración.
