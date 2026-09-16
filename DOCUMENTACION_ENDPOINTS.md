# Documentación de Endpoints y Estructuras JSON

Documento de referencia para la integración con la API REST del sistema **Aktun Kan Backend**. Contiene los métodos HTTP, rutas, parámetros, estructuras del cuerpo de solicitud (`Request Body`) y respuestas esperadas (`Response Body`) en formato JSON para las operaciones de **POST**, **GET**, **PATCH/UPDATE**, **ACTIVAR**, **RESTABLECER CONTRASEÑA** y **DELETE/ANULAR**.

---

## Novedades en Autenticación
- **Restablecimiento de Contraseña con Código de 6 Dígitos:** Se agregaron los endpoints públicos `POST /auth/solicitar-codigo-restablecimiento`, `POST /auth/validar-codigo-restablecimiento` y `POST /auth/restablecer-contrasena` con envío de correos vía Nodemailer.
- **Activación de Registros:** Endpoints explícitos `PATCH /:id/activar` para reactivar registros anulados en **Usuarios**, **Puestos** y **Módulos**.

---

## Seguridad y límites de peticiones

**`JWT_SECRET` es obligatorio.** La aplicación **no arranca** si falta o tiene menos de 32 caracteres (`src/auth/auth.module.ts`). Antes existía un valor por defecto en el código, lo que permitía firmar tokens de cualquier usuario a quien tuviera acceso al repositorio; ese fallback se eliminó. Cambiar el secreto invalida todas las sesiones activas.

### Sesiones: token de acceso + refresh token

⚠️ **Cambio de contrato con el frontend.** `POST /auth/login` ya no devuelve un token de larga duración: devuelve un **access token corto** (30 min) y un **refresh token** con el que renovarlo.

| Token | Duración | Revocable |
|---|---|---|
| `access_token` (JWT) | `JWT_ACCESS_EXPIRA`, por defecto **30 min** | No — por eso dura poco |
| `refresh_token` (cadena opaca) | **30 días** con `recordarme: true`, **24 h** sin él | **Sí**, individualmente |

Cómo funciona y por qué:

- El refresh se guarda en la tabla `SesionRefresh` **solo como hash SHA-256**: si la base de datos se filtrara, los valores almacenados no sirven para autenticarse.
- **Rotación en cada uso:** al refrescar, el token anterior se revoca y se emite uno nuevo, conservando la fecha de expiración original (refrescar no alarga la sesión indefinidamente).
- **Detección de robo:** si llega un refresh **ya revocado**, se asume que alguien lo copió y se cierran **todas las sesiones de ese usuario**, con registro `ALERTA_SESION` en Bitácora. No afecta a ningún otro usuario.
- Restablecer la contraseña cierra todas las sesiones de ese usuario.

**Qué debe hacer el frontend:** guardar ambos tokens; ante un `401`, llamar a `POST /auth/refresh` con el `refresh_token`, **reemplazar los dos** por los nuevos y reintentar la petición. Si el refresh también falla, enviar al login.

| Ruta | Auth | Descripción |
|---|---|---|
| `POST /auth/refresh` | Pública | `{ refresh_token }` → nuevo par de tokens. 30/min por IP |
| `POST /auth/logout` | Pública | `{ refresh_token }` → cierra **esa** sesión; las demás siguen activas |
| `POST /auth/logout-todas` | Token | Cierra todas las sesiones del usuario autenticado |
| `GET /auth/sesiones` | Token | Sesiones activas propias (fecha, IP, dispositivo) |
| `DELETE /auth/sesiones/:id` | Token | Cierra una sesión concreta (ej. una taquilla olvidada) |

Respuesta de `POST /auth/login` y `POST /auth/refresh`:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "rQ8-A_q1N7N4ZhM9O-rW7IQSfqf-lkO5By2cpP7ypAE",
  "token_type": "Bearer",
  "expires_in": "30m",
  "refresh_expira": "2026-09-12T17:00:00.000Z"
}
```
> `login` incluye además el objeto `usuario`.

**Una excepción, acotada:** un usuario **dado de baja** puede renovar su sesión si —y solo si— tiene ventas offline sin liquidar. En ese caso la respuesta trae `solo_sincronizacion: true` y el token que recibe **no sirve para nada más que subir y conciliar esas ventas**. Ver sección 18.6.

**Límite de peticiones por IP** (`@nestjs/throttler`, primer guard global):

| Alcance | Límite | Respuesta al excederlo |
|---|---|---|
| Toda la API | `THROTTLE_LIMITE` por `THROTTLE_TTL_SEGUNDOS` (por defecto 120 por minuto) | `429 Too Many Requests` |
| `POST /auth/login` | 10 por minuto | `429` |
| `POST /auth/validar-codigo-restablecimiento` y `/auth/restablecer-contrasena` | 10 por minuto | `429` |
| `POST /auth/solicitar-codigo-restablecimiento` | 5 por hora | `429` |

> El límite se evalúa **antes** de verificar el token, para que una ráfaga se descarte sin tocar la base de datos.
>
> Si la aplicación corre detrás de un proxy inverso, hay que poner `TRUST_PROXY=true`; de lo contrario todas las peticiones llegan con la IP del proxy y el límite se comparte entre todos los usuarios. Actívelo solo con un proxy de confianza al frente: expuesto directo a internet, permitiría falsificar la IP con `X-Forwarded-For`.

### Variables de entorno requeridas

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DATABASE_URL` | Sí | Cadena de conexión a SQL Server |
| `JWT_SECRET` | **Sí** | Firma de los tokens, mínimo 32 caracteres |
| `JWT_ACCESS_EXPIRA` | No | Vida del token de acceso (por defecto `30m`) |
| `CORS_ORIGINS` | No | Dominios permitidos separados por coma. Vacío = cualquiera (solo desarrollo) |
| `TICKET_QR_SECRET` | Recomendada | Firma HMAC del QR; si cambia, los pases impresos dejan de validar |
| `TICKET_SERIE` | No | Serie del folio correlativo (por defecto `TCK`) |
| `THROTTLE_LIMITE` / `THROTTLE_TTL_SEGUNDOS` | No | Límite global de peticiones (120 / 60 s) |
| `TRUST_PROXY` | No | `true` solo detrás de un proxy inverso de confianza |
| `UPLOADS_DIR` | No | Carpeta raíz de archivos subidos (por defecto `./uploads`). Las imágenes de actividades van a `<UPLOADS_DIR>/actividades` |
| `OFFLINE_EXPIRA_HORA` | No | Hora a la que vence un lote de folios offline (por defecto `6`) |
| `SMTP_*` | Sí para correos | Configuración de Nodemailer |
| `IA_BASE_URL` / `IA_API_KEY` / `IA_MODELO` | No | Interpretación de reportes en lenguaje natural (19.5). Sin `IA_API_KEY` el módulo arranca igual y solo esa ruta responde `503`; los 18 reportes predeterminados no la usan |

## Estructura de permisos

El sistema se organiza en **módulos generales**, que pueden agrupar **sub-módulos** con permisos propios (`Modulo.idModuloPadre`). El permiso siempre se evalúa como **módulo + acción**.

| Módulo general | Sub-módulos | Cubre |
|---|---|---|
| `EmisionTickets` | — | Todo lo relacionado a tickets: emisión, historial, validación de QR, tarifas y la lectura de catálogos (atracciones, guías, países, tipos, formas de pago) |
| `Cajas` | `Gastos` | Apertura, cierre y arqueo. `Gastos` es sub-módulo con permisos propios (incluye el catálogo de tipos de gasto) |
| `Usuarios` | `Puestos` | Usuarios, puestos y todo el catálogo de permisos (`/modulos`, `/acciones`, `/modulo-acciones`) |
| `Donaciones` | — | Registro, consulta y anulación de recibos de donación |
| `ActividadesParque` | — | Publicación y consulta de actividades del parque, con sus imágenes y el catálogo de sectores (`/sectores`) |
| `Bitacora` | — | Consulta de bitácora |
| `Reportes` | — | Catálogo de reportes, ejecución en JSON y exportación a PDF y Excel |

> **Emisión de Tickets es un módulo general**: atracciones, guías, tarifas y demás catálogos **no** son módulos de permiso aparte. Quien tiene permiso sobre `EmisionTickets` lo tiene sobre todo el módulo, con la granularidad de las 4 acciones.

### Administración del catálogo de permisos

Las rutas `/modulos`, `/acciones` y `/modulo-acciones` **exigen permiso sobre `Usuarios`**, porque administrar el catálogo de permisos es parte de administrar usuarios. Ya no existen filas `Modulos` ni `Acciones` en la tabla `Modulo`: eran módulos que se protegían a sí mismos y solo generaban confusión al asignar permisos.

- `GET /modulo-acciones` devuelve **solo los vínculos asignables** (módulos activos y no de infraestructura); es lo que debe alimentar la pantalla de asignación. Con `?incluirNoAsignables=true` se ve todo.
- `GET /modulos?soloAsignables=true` filtra por el campo `esAsignable`, disponible para cualquier módulo interno que se agregue en el futuro.
- `POST /usuarios/:id/permisos` **rechaza con `400`** los vínculos de módulos no asignables o anulados, indicando qué IDs se rechazaron.

El menú **no** depende de ningún permiso: usa `GET /modulos/mis-modulos` (ver 4.7), que solo exige sesión válida. Así, cambiar la asignación de permisos nunca deja a un usuario sin navegación.

Pendiente de implementar (aún sin código): `Sincronizacion`.

> **El permiso no siempre es la última palabra.** En `ActividadesParque`, editar y anular quedan además reservados al **autor** de cada publicación: tener la acción habilita publicar y mantener lo propio, no tocar lo ajeno (ver sección 16).

- **Acciones:** `'Ver'`, `'Crear'`, `'Editar'`, `'Anular'`, `'Exportar'`
- Un handler **sin** `@RequirePermission` queda accesible a cualquier usuario autenticado (`permissions.guard.ts` es fail-open por diseño), así que toda ruta nueva debe declararlo explícitamente.
- `@PermiteUsuarioAnulado()` deja pasar a un usuario dado de baja **solo** en ese handler, y hoy está aplicado únicamente en los dos de sincronización offline (18.6). No se hereda ni se activa por omisión.

## Control de arqueo: qué ve el cajero y qué ve el supervisor

**Quien cuenta el efectivo no debe conocer el monto esperado.** Si lo supiera, bastaría teclear esa cifra para que ningún faltante saliera nunca a la luz. Por eso el backend **no lo expone** a quien solo opera la caja — ocultarlo en el frontend sería inútil, porque el dato viajaría igual y se leería en la pestaña de red.

La supervisión se representa con **`Cajas.Editar`**, una acción que quedó libre al definir que las cajas son inmutables.

| Capacidad | Cajero (`Ver` + `Crear`) | Supervisor (+ `Editar`) |
|---|---|---|
| Abrir y cerrar caja | Sí | Sí |
| Ver `montoInicial`, `montoFinal` (lo que él contó) | Sí | Sí |
| `GET /cajas/:id/arqueo` (monto esperado) | **403** | Sí |
| `montoEsperado` y `diferencia` en el cierre | **Se omiten** | Sí |
| `GET /cajas/cierres` (historial) | **403** | Sí |
| Anular un cierre y reabrir la caja | **403** | Sí |
| `discrepanciaOffline` (cobros offline mal hechos) | **Se omite** | Sí |
| Forzar el cierre con un lote offline pendiente | **403** | Sí |

> **Anular un cierre exige `Cajas.Editar`, no `Anular`.** De lo contrario el cajero podría cerrar, ver la diferencia, anular y volver a cerrar con la cifra exacta: el arqueo perdería todo valor de control. Con `Anular` sigue pudiendo anular tickets y aperturas equivocadas.
>
> Ocultar estas cifras es solo de cara al cliente: **el arqueo siempre se calcula y se guarda** en `CierreCaja`, así que los reportes y la auditoría lo conservan íntegro.

## Paginación de listados

Todos los listados de volumen relevante se paginan **en el servidor**. Aceptan los mismos dos parámetros y devuelven siempre el mismo sobre.

| Parámetro | Por defecto | Máximo |
|---|---|---|
| `pagina` | `1` | — |
| `limite` | `20` en todos | `200` (100 en `/actividades`) |

```json
{
  "datos":  [ /* la página solicitada */ ],
  "total":  1627,
  "pagina": 1,
  "limite": 20
}
```

- **`total` es el conjunto filtrado completo, no el tamaño de la página.** Es con lo que el frontend calcula cuántas páginas hay; `datos.length` solo dice cuántas filas trajo esta petición.
- Una `pagina` más allá del final devuelve `200` con `datos: []` y el `total` real, nunca un error.
- `limite=0`, negativo o por encima del tope responde **`400`** con el mensaje en español.
- Donde hay dinero (`/tickets`, `/donaciones`, `/cajas/cierres`) el sobre trae además `metricas`, que **describe el filtro completo y no cambia al pasar de página**.
- **El orden es estable entre páginas.** Cada listado ordena por su clave natural y desempata por `id`. Sin ese desempate, dos filas con la misma fecha podrían repetirse o perderse al pasar de página: SQL Server resuelve `pagina`/`limite` con `OFFSET..FETCH`, que sobre una clave repetida no garantiza un orden determinado.

**Endpoints paginados:** `/usuarios`, `/bitacora`, `/cajas`, `/cajas/cierres`, `/guias`, `/tarifas/historico`, `/tickets`, `/donaciones`, `/actividades`.

**Endpoints que NO se paginan** — son catálogos cortos que alimentan selectores del formulario, y paginarlos los dejaría incompletos: `/puestos`, `/acciones`, `/modulos`, `/modulo-acciones`, `/modulos/mis-modulos`, `/sectores`, `/tarifas` (vigentes), `/tickets/catalogos`, `/auth/sesiones`. Siguen devolviendo un arreglo plano.

> ### ⚠️ Cambio de contrato
>
> Estos cinco endpoints **dejaron de devolver un arreglo plano** y ahora devuelven el sobre. El frontend debe leer `.datos` en lugar de iterar la respuesta directamente:
>
> | Endpoint | Antes | Ahora |
> |---|---|---|
> | `GET /usuarios` | `[ … ]` | `{ datos, total, pagina, limite }` |
> | `GET /bitacora` | `[ … ]` | `{ datos, total, pagina, limite }` |
> | `GET /cajas` | `[ … ]` | `{ datos, total, pagina, limite }` |
> | `GET /guias` | `[ … ]` | `{ datos, total, pagina, limite }` |
> | `GET /tarifas/historico` | `[ … ]` | `{ datos, total, pagina, limite }` |
>
> `/tickets`, `/donaciones`, `/cajas/cierres` y `/actividades` ya devolvían el sobre: no cambian.
>
> Además, estos tres endpoints pasaron a validar su *query string* con un DTO. Un parámetro no reconocido, que antes se ignoraba en silencio, ahora responde `400`: `/usuarios` (`incluirAnulados`), `/guias` (`buscar`, `incluirAnulados`) y `/tarifas/historico` (`idAtraccion`, `idOrigen`) — más `pagina` y `limite` en los tres.

## Novedades en Cajas
- **Apertura y cierre de caja con arqueo automático:** Se agregó el módulo `/cajas`. Al cerrar, el sistema calcula el monto esperado (`montoInicial + ventas en efectivo - gastos`) y lo compara contra el monto contado, generando una `diferencia` (sobrante/faltante).
- **Inmutabilidad:** Ni la apertura ni el cierre se editan una vez creados — solo se pueden **anular**. La acción `'Editar'` del módulo `Cajas` representa **supervisión**: ver el arqueo, el historial de cierres y anular un cierre.
- **Gastos:** Se agregó `/gastos` (registro de gastos contra la caja abierta actual) y su catálogo `/tipos-gasto`.
- **Integridad del arqueo:** un gasto solo puede crearse, editarse o anularse mientras su caja sigue **abierta**. Tocarlo después del cierre devuelve `400`, porque alteraría de forma retroactiva un arqueo ya guardado.
- **Reapertura controlada:** anular un cierre devuelve `409` si en ese momento hay otra caja abierta; nunca pueden quedar dos cajas abiertas a la vez.
- **Trazabilidad:** cada gasto guarda `idUsuario` (quién lo registró), además del registro en Bitácora.
- **Configuración requerida tras desplegar:** ejecutar `npx ts-node prisma/seed-modulos-dinero.ts` para registrar el módulo general `'Cajas'` y su sub-módulo `'Gastos'` con sus acciones (script aditivo e idempotente). Después, otorgar los permisos a cada usuario con `POST /usuarios/:id/permisos`.

## Novedades en Tickets
- **Módulo de emisión completo:** `/tickets` (catálogos, emisión, historial con métricas y validación de QR en taquilla) y `/tarifas` con vigencia histórica.
- **Sin CRUD por catálogo:** atracciones, orígenes, países, tipos y formas de pago son datos de configuración que alimentan el formulario. Se leen todos con `GET /tickets/catalogos` y se administran por seed.
- **Pase imprimible en PDF:** `GET /tickets/:id/pdf` (ver 11.6), con QR de validación, desglose por categoría y color distinto para visitante y guía.
- **Guías:** consulta y mantenimiento en `/guias` (sección 14). El alta sigue ocurriendo dentro de la emisión, y los nombres repetidos se rechazan con `409`.
- **Cierra el circuito de dinero:** cada ticket queda asociado a la caja abierta y genera su `TicketPago`; el arqueo de `/cajas/:id/arqueo` por fin suma ventas en efectivo además de restar gastos.
- **Variables de entorno nuevas:** `TICKET_QR_SECRET` (firma HMAC del QR — si cambia, los pases ya impresos dejan de validar) y `TICKET_SERIE` (serie alfanumérica del folio, default `TCK`).
- **Permiso único:** todo el módulo se controla con `EmisionTickets` + acción. Los catálogos (atracciones, guías, tarifas, países…) **no** tienen módulo de permiso propio.
- **Seed:** `npx ts-node prisma/seed-tickets.ts` siembra catálogos y tarifas iniciales; `npx ts-node prisma/reorganizar-modulos.ts` consolida la estructura de módulos generales y sub-módulos.

## Novedades en Venta offline
- **Se puede vender sin internet:** `/tickets/lotes-offline` y `/tickets/emitir-offline` (sección 18). El servidor entrega folios pre-firmados, el dispositivo los consume sin red y al reconectar sube la cola.
- **El pase es válido desde la venta:** el QR se firma al reservar el folio, así que el visitante entra aunque el ticket todavía no exista en el servidor.
- **Un folio reservado no es un pase válido:** `POST /tickets/validar` responde `404` por él hasta que la venta se sube. No hizo falta cambiar nada — los folios viven en su propia tabla, no en `Ticket`.
- **Idempotencia real:** cada venta lleva un `idLocal` y reintentar la subida no duplica tickets. **Depende de dos índices únicos filtrados que `prisma db push` no crea**; ver 18.7.
- **La caja no cierra con un lote pendiente:** `POST /cajas/:id/cierre` responde `409`, con salida de emergencia `forzarLoteOffline` para supervisores (8.6).
- **Los cobros mal hechos salen a la luz:** `discrepanciaOffline` en el arqueo (8.5), oculto al cajero.
- **Tarifas históricas:** una venta de ayer se recalcula con el precio de ayer, no con el de hoy.
- **Un usuario dado de baja puede liquidar lo que ya vendió**, y nada más (18.6).
- **Variable de entorno nueva:** `OFFLINE_EXPIRA_HORA` (opcional, por defecto `6`).

## Novedades en Actividades del Parque
- **Módulo de planificación:** `/actividades` (sección 16). El autor publica una actividad y define **desde cuándo y hasta cuándo** la ven los demás.
- **Autoría por encima del permiso:** editar, anular y administrar imágenes son exclusivos del autor. Cualquier otro usuario, aunque tenga la acción, recibe `403`.
- **Ventana de visibilidad:** fuera del rango de fechas la publicación desaparece para los demás (`404`), pero el autor la sigue viendo marcada como `expirada` o `programada` para poder reprogramarla.
- **Imágenes en disco, no en la base:** la fila guarda solo el nombre del archivo (~140 bytes); el binario vive en `<UPLOADS_DIR>/actividades`. Meter imágenes en la base la haría crecer sin control y penalizaría cada consulta que tocara la tabla.
- **Las imágenes se sirven por endpoint, no como archivos estáticos**, para que respeten el permiso del módulo y la ventana de visibilidad.
- **Catálogo de sectores:** `/sectores` (sección 17), la lista que alimenta el campo `idSectorParque`. Se gobierna con el mismo permiso `ActividadesParque`, no es un módulo aparte.
- **Variable de entorno nueva:** `UPLOADS_DIR` (opcional; por defecto `./uploads`).
- **Seed:** `npx ts-node prisma/seed-actividades.ts` registra el módulo `ActividadesParque` con sus 4 acciones. Después, otorgar el permiso con `POST /usuarios/:id/permisos`.

## Novedades en Reportes
- **Módulo nuevo:** `/reportes` (sección 19), con **18 reportes predeterminados** que cubren los seis módulos principales: Tickets, Cajas, Donaciones, Bitácora, Usuarios y Actividades.
- **Tres formatos:** JSON para pintar la tabla, PDF para imprimir y Excel para filtrar y sumar. El PDF y el Excel se generan **en el backend**; el frontend solo elige a qué URL navegar.
- **Los números del Excel son números**, con su formato de moneda: la hoja trae autofiltro, encabezados congelados y totales con `SUBTOTAL`, que se recalculan al filtrar dentro de la hoja.
- **Reportes a medida en lenguaje natural:** `POST /reportes/interpretar` traduce una frase como *"ventas del vendedor Juan en las cuevas en agosto"* a uno de esos mismos 18 reportes. **La IA traduce, no consulta**: nunca escribe SQL, nunca ve datos y nunca redacta una cifra.
- **El uso diario no gasta cuota:** los 18 reportes predeterminados no salen a internet en ningún momento. Solo la petición escrita a mano consume una llamada, y su respuesta trae ya la URL de la vía normal para que repetirla sea gratis.
- **A la IA no viaja ningún dato del negocio:** solo la frase del usuario y la descripción estructural del catálogo. Los nombres propios ("Juan", "cuevas") los resuelve el backend contra su propia base.
- **Permisos en tres capas:** `Reportes.Ver` / `Reportes.Exportar` abren el módulo, cada reporte exige además `Ver` sobre el módulo dueño de sus datos, y las cifras del arqueo siguen reservadas a `Cajas.Editar` (19.6). Estrena la acción `'Exportar'`, que estaba en el catálogo sin usarse.
- **El cajero sigue sin ver el monto esperado:** las columnas de supervisión se borran del dato, no del dibujo, así que tampoco aparecen en el JSON ni dentro del `.xlsx`.
- **Toda generación queda en bitácora**, con la clave del reporte y el período.
- **Índices nuevos:** `Bitacora` no tenía ninguno y `TicketPago.idTicket` tampoco. Además hay índices de cobertura que Prisma no sabe declarar; se aplican con `npx ts-node prisma/aplicar-indices-reportes.ts` después de cada `db push` (19.8).
- **Variables de entorno nuevas (opcionales):** `IA_BASE_URL`, `IA_API_KEY`, `IA_MODELO`. Sin ellas el módulo arranca igual y solo la ruta de interpretación responde `503`.
- **Seed:** `npx ts-node prisma/seed-reportes.ts` registra el módulo `Reportes` con `Ver` y `Exportar`. Después, otorgar los permisos con `POST /usuarios/:id/permisos`.

---

## Índice de Contenidos

**Conceptos transversales** (leer antes de integrar):

- [Seguridad y límites de peticiones](#seguridad-y-límites-de-peticiones) — `JWT_SECRET`, sesiones con refresh token, rate limit, variables de entorno
- [Estructura de permisos](#estructura-de-permisos) — módulos generales, sub-módulos y catálogo de permisos
- [Control de arqueo](#control-de-arqueo-qué-ve-el-cajero-y-qué-ve-el-supervisor) — qué cifras ve el cajero y cuáles solo el supervisor
- [Paginación de listados](#paginación-de-listados) — `pagina`/`limite`, el sobre `{datos,total,pagina,limite}`, qué se pagina y qué no

**Endpoints:**

1. [Autenticación (`/auth`)](#1-autenticación-auth)
2. [Usuarios (`/usuarios`)](#2-usuarios-usuarios)
3. [Puestos (`/puestos`)](#3-puestos-puestos)
4. [Módulos (`/modulos`)](#4-módulos-modulos)
5. [Acciones (`/acciones`)](#5-acciones-acciones)
6. [Módulo-Acciones (`/modulo-acciones`)](#6-módulo-acciones-modulo-acciones)
7. [Bitácora y Auditoría (`/bitacora`)](#7-bitácora-y-auditoría-bitacora)
8. [Cajas (`/cajas`)](#8-cajas-cajas)
9. [Gastos (`/gastos`)](#9-gastos-gastos)
10. [Tipos de Gasto (`/tipos-gasto`)](#10-tipos-de-gasto-tipos-gasto)
11. [Tickets (`/tickets`)](#11-tickets-tickets)
12. [Tarifas (`/tarifas`)](#12-tarifas-tarifas)
13. [Catálogos de Tickets (`GET /tickets/catalogos`)](#13-catálogos-de-tickets--get-ticketscatalogos)
14. [Guías (`/guias`)](#14-guías-guias)
15. [Donaciones (`/donaciones`)](#15-donaciones-donaciones)
16. [Actividades del Parque (`/actividades`)](#16-actividades-del-parque-actividades)
17. [Sectores del Parque (`/sectores`)](#17-sectores-del-parque-sectores)
18. [Venta offline (`/tickets/lotes-offline`)](#18-venta-offline-ticketslotes-offline-ticketsemitir-offline)
19. [Reportes (`/reportes`)](#19-reportes-reportes)

---

## 1. Autenticación (`/auth`)

### 1.1 `POST /auth/login`
Inicia sesión y devuelve un **par de tokens**: uno de acceso (corto) y uno de refresco (largo y revocable). Ver [Sesiones](#sesiones-token-de-acceso--refresh-token).

* **Headers:** `Content-Type: application/json`
* **Request Body (JSON):**
```json
{
  "correo": "admin@aktunkan.com",
  "contrasena": "Password123!",
  "recordarme": true
}
```
> **Nota de Duración de la Sesión:**
> - El `access_token` dura **30 minutos** siempre; se renueva con `POST /auth/refresh`.
> - El `refresh_token` dura **30 días** si `"recordarme": true`, o **24 horas** si se omite.

* **Response (201 Created - JSON):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "rQ8-A_q1N7N4ZhM9O-rW7IQSfqf-lkO5By2cpP7ypAE",
  "token_type": "Bearer",
  "expires_in": "30m",
  "refresh_expira": "2026-09-12T17:00:00.000Z",
  "usuario": {
    "id": 1,
    "idPuesto": 1,
    "nombre": "Administrador General",
    "correo": "admin@aktunkan.com",
    "telefono": "55551234",
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z",
    "anulado": false
  }
}
```
> El `refresh_token` se muestra **una sola vez**: en la base de datos solo queda su hash. Guárdalo junto con el `access_token`.

---

### 1.2 `GET /auth/me`
Obtiene la información del perfil del usuario autenticado actual.

* **Headers:** `Authorization: Bearer <token_jwt>`
* **Response (200 OK - JSON):**
```json
{
  "id": 1,
  "idPuesto": 1,
  "nombre": "Administrador General",
  "correo": "admin@aktunkan.com",
  "telefono": "55551234",
  "fechaCreacion": "2026-07-24T14:00:00.000Z",
  "fechaActualizacion": "2026-07-24T14:00:00.000Z",
  "anulado": false,
  "puesto": {
    "id": 1,
    "nombre": "Administrador",
    "descripcion": "Acceso total al sistema",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z"
  },
  "permiso": []
}
```

---

### 1.3 `POST /auth/solicitar-codigo-restablecimiento` (Público)
Genera un código aleatorio de 6 dígitos con expiración de 15 minutos y lo envía al correo del usuario vía Nodemailer.

* **Headers:** `Content-Type: application/json`
* **Request Body (JSON):**
```json
{
  "correo": "usuario@aktunkan.com"
}
```

* **Response (201 Created - JSON):**
```json
{
  "mensaje": "Se ha enviado un código de verificación de 6 dígitos al correo electrónico 'usuario@aktunkan.com'.",
  "expiracionMinutos": 15
}
```

---

### 1.4 `POST /auth/validar-codigo-restablecimiento` (Público)
Valida si un código de 6 dígitos ingresado por el usuario es correcto y no ha expirado.

* **Headers:** `Content-Type: application/json`
* **Request Body (JSON):**
```json
{
  "correo": "usuario@aktunkan.com",
  "codigo": "482915"
}
```

* **Response (201 Created - JSON):**
```json
{
  "valido": true,
  "mensaje": "El código de verificación es válido."
}
```

---

### 1.5 `POST /auth/restablecer-contrasena` (Público)
Valida el código de 6 dígitos y actualiza la contraseña del usuario con encriptación bcrypt en la base de datos bajo transacción atómica.

* **Headers:** `Content-Type: application/json`
* **Request Body (JSON):**
```json
{
  "correo": "usuario@aktunkan.com",
  "codigo": "482915",
  "nuevaContrasena": "NuevaClaveSegura2026!"
}
```

* **Response (201 Created - JSON):**
```json
{
  "mensaje": "La contraseña ha sido restablecida exitosamente. Ya puede iniciar sesión con su nueva contraseña."
}
```

---

## 2. Usuarios (`/usuarios`)

### 2.1 `POST /usuarios` (Crear Usuario)
Registra un nuevo usuario en la base de datos bajo transacción atómica.

* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Crear'`
* **Headers:** `Authorization: Bearer <token_jwt>`, `Content-Type: application/json`
* **Request Body (JSON):**
```json
{
  "nombre": "Carlos Mendoza",
  "correo": "carlos.mendoza@aktunkan.com",
  "contrasena": "ClaveSegura2026",
  "idPuesto": 2,
  "telefono": "55554321"
}
```

* **Response (201 Created - JSON):**
```json
{
  "id": 2,
  "idPuesto": 2,
  "nombre": "Carlos Mendoza",
  "correo": "carlos.mendoza@aktunkan.com",
  "telefono": "55554321",
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:03:35.000Z",
  "anulado": false,
  "puesto": {
    "id": 2,
    "nombre": "Taquillero",
    "descripcion": "Atención y venta de tickets",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z"
  }
}
```

---

### 2.2 `GET /usuarios` (Listar Usuarios)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Query Params (todos opcionales):** `incluirAnulados=true`, `pagina` (default 1), `limite` (default 20, máx. 200)
* **Response (200 OK - JSON):** sobre paginado — ver [Paginación de listados](#paginación-de-listados).
```json
{
  "datos": [
    {
      "id": 1,
      "idPuesto": 1,
      "nombre": "Administrador General",
      "correo": "admin@aktunkan.com",
      "telefono": "55551234",
      "fechaCreacion": "2026-07-24T14:00:00.000Z",
      "fechaActualizacion": "2026-07-24T14:00:00.000Z",
      "anulado": false,
      "puesto": {
        "id": 1,
        "nombre": "Administrador",
        "descripcion": "Acceso total al sistema",
        "anulado": false,
        "fechaCreacion": "2026-07-24T14:00:00.000Z",
        "fechaActualizacion": "2026-07-24T14:00:00.000Z"
      },
      "permiso": []
    }
  ],
  "total": 4,
  "pagina": 1,
  "limite": 20
}
```
> El listado **nunca** incluye `contrasena`, ni siquiera cifrada.

---

### 2.3 `GET /usuarios/:id` (Obtener Usuario por ID)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 2,
  "idPuesto": 2,
  "nombre": "Carlos Mendoza",
  "correo": "carlos.mendoza@aktunkan.com",
  "telefono": "55554321",
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:03:35.000Z",
  "anulado": false,
  "puesto": {
    "id": 2,
    "nombre": "Taquillero",
    "descripcion": "Atención y venta de tickets",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z"
  },
  "permiso": []
}
```

---

### 2.4 `PATCH /usuarios/:id` (Actualizar Usuario)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Editar'`
* **Path Params:** `id` (número entero)
* **Request Body (JSON - Todos los campos opcionales):**
```json
{
  "nombre": "Carlos Alberto Mendoza",
  "telefono": "55559999",
  "idPuesto": 2
}
```

* **Response (200 OK - JSON):**
```json
{
  "id": 2,
  "idPuesto": 2,
  "nombre": "Carlos Alberto Mendoza",
  "correo": "carlos.mendoza@aktunkan.com",
  "telefono": "55559999",
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:05:00.000Z",
  "anulado": false,
  "puesto": {
    "id": 2,
    "nombre": "Taquillero",
    "descripcion": "Atención y venta de tickets",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z"
  }
}
```

---

### 2.5 `PATCH /usuarios/:id/activar` (Reactivar Usuario)
Reactiva un usuario previamente anulado (`anulado: false`) bajo transacción atómica.

* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Editar'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 2,
  "idPuesto": 2,
  "nombre": "Carlos Alberto Mendoza",
  "correo": "carlos.mendoza@aktunkan.com",
  "telefono": "55559999",
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:15:00.000Z",
  "anulado": false,
  "puesto": {
    "id": 2,
    "nombre": "Taquillero",
    "descripcion": "Atención y venta de tickets",
    "anulado": false
  }
}
```

---

### 2.6 `DELETE /usuarios/:id` (Anular Usuario)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Anular'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 2,
  "idPuesto": 2,
  "nombre": "Carlos Alberto Mendoza",
  "correo": "carlos.mendoza@aktunkan.com",
  "telefono": "55559999",
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:06:00.000Z",
  "anulado": true
}
```

---

### 2.7 `POST /usuarios/:id/permisos` (Asignar / Reemplazar Permisos)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Editar'`
* **Path Params:** `id` (ID del usuario)
* **Request Body (JSON - Permite arreglo vacío `[]` para revocar todos):**
```json
{
  "idsModuloAccion": [1, 2, 3, 5]
}
```
> ⚠️ **Reemplaza la lista completa**: los permisos que no vengan en el arreglo se revocan. Envía siempre el conjunto completo que debe quedar, no solo los nuevos.
>
> Devuelve `400` si alguno de los IDs pertenece a un módulo con `esAsignable: false` (`Modulos`, `Acciones`).

* **Response (200 OK - JSON):**
```json
{
  "id": 2,
  "idPuesto": 2,
  "nombre": "Carlos Alberto Mendoza",
  "correo": "carlos.mendoza@aktunkan.com",
  "telefono": "55559999",
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:06:00.000Z",
  "anulado": false,
  "puesto": {
    "id": 2,
    "nombre": "Taquillero",
    "descripcion": "Atención y venta de tickets",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z"
  },
  "permiso": [
    {
      "id": 10,
      "idUsuario": 2,
      "idModuloAccion": 1,
      "moduloAccion": {
        "id": 1,
        "idModulo": 1,
        "idAccion": 1,
        "modulo": { "id": 1, "nombre": "Puestos", "anulado": false },
        "accion": { "id": 1, "nombre": "Ver" }
      }
    }
  ]
}
```

---

## 3. Puestos (`/puestos`)

### 3.1 `POST /puestos` (Crear Puesto)
* **Permiso requerido:** `Módulo: 'Puestos'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{
  "nombre": "Guía de Recorrido",
  "descripcion": "Encargado de guiados dentro del parque"
}
```

* **Response (201 Created - JSON):**
```json
{
  "id": 3,
  "nombre": "Guía de Recorrido",
  "descripcion": "Encargado de guiados dentro del parque",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:03:35.000Z"
}
```

---

### 3.2 `GET /puestos` (Listar Puestos)
* **Permiso requerido:** `Módulo: 'Puestos'`, `Acción: 'Ver'`
* **Query Params (Opcional):** `?incluirAnulados=true`
* **Response (200 OK - JSON):**
```json
[
  {
    "id": 1,
    "nombre": "Administrador",
    "descripcion": "Acceso total al sistema",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z"
  }
]
```

---

### 3.3 `GET /puestos/:id` (Obtener Puesto por ID)
* **Permiso requerido:** `Módulo: 'Puestos'`, `Acción: 'Ver'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 3,
  "nombre": "Guía de Recorrido",
  "descripcion": "Encargado de guiados dentro del parque",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:03:35.000Z",
  "_count": {
    "usuarios": 0
  }
}
```

---

### 3.4 `PATCH /puestos/:id` (Actualizar Puesto)
* **Permiso requerido:** `Módulo: 'Puestos'`, `Acción: 'Editar'`
* **Path Params:** `id` (número entero)
* **Request Body (JSON - Campos opcionales):**
```json
{
  "nombre": "Guía Turístico Principal",
  "descripcion": "Encargado senior de guiados en el parque"
}
```

* **Response (200 OK - JSON):**
```json
{
  "id": 3,
  "nombre": "Guía Turístico Principal",
  "descripcion": "Encargado senior de guiados en el parque",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:07:00.000Z"
}
```

---

### 3.5 `PATCH /puestos/:id/activar` (Reactivar Puesto)
Reactiva un puesto anulado (`anulado: false`) bajo transacción atómica.

* **Permiso requerido:** `Módulo: 'Puestos'`, `Acción: 'Editar'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 3,
  "nombre": "Guía Turístico Principal",
  "descripcion": "Encargado senior de guiados en el parque",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:15:00.000Z"
}
```

---

### 3.6 `DELETE /puestos/:id` (Anular Puesto)
* **Permiso requerido:** `Módulo: 'Puestos'`, `Acción: 'Anular'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 3,
  "nombre": "Guía Turístico Principal",
  "descripcion": "Encargado senior de guiados en el parque",
  "anulado": true,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:08:00.000Z"
}
```

---

## 4. Módulos (`/modulos`)

### 4.1 `POST /modulos` (Crear Módulo)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{
  "nombre": "Tickets"
}
```

* **Response (201 Created - JSON):**
```json
{
  "id": 4,
  "nombre": "Tickets",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:03:35.000Z"
}
```

---

### 4.2 `GET /modulos` (Listar Módulos)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Query Params (Opcionales):** `?incluirAnulados=true`, `?soloAsignables=true` (excluye los módulos de infraestructura; úsalo en la pantalla de asignación de permisos)
* **Response (200 OK - JSON):**
```json
[
  {
    "id": 1,
    "nombre": "Usuarios",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z",
    "moduloAcciones": [
      {
        "id": 1,
        "idModulo": 1,
        "idAccion": 1,
        "accion": { "id": 1, "nombre": "Ver" }
      }
    ]
  }
]
```

---

### 4.3 `GET /modulos/:id` (Obtener Módulo por ID)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 4,
  "nombre": "Tickets",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:03:35.000Z",
  "moduloAcciones": []
}
```

---

### 4.4 `PATCH /modulos/:id` (Actualizar Módulo)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Editar'`
* **Path Params:** `id` (número entero)
* **Request Body (JSON):**
```json
{
  "nombre": "VentaTickets"
}
```

* **Response (200 OK - JSON):**
```json
{
  "id": 4,
  "nombre": "VentaTickets",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:09:00.000Z"
}
```

---

### 4.5 `PATCH /modulos/:id/activar` (Reactivar Módulo)
Reactiva un módulo anulado (`anulado: false`) bajo transacción atómica.

* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Editar'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 4,
  "nombre": "VentaTickets",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:15:00.000Z"
}
```

---

### 4.6 `DELETE /modulos/:id` (Anular Módulo)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Anular'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 4,
  "nombre": "VentaTickets",
  "anulado": true,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:10:00.000Z"
}
```

---

### 4.7 `GET /modulos/mis-modulos` (Menú del usuario autenticado)
Devuelve los módulos a los que el usuario de la sesión tiene acceso, con las acciones que efectivamente se le concedieron. Es lo que debe alimentar el menú del frontend.

* **Permiso requerido:** ninguno — basta un token válido. Cada usuario consulta su propio acceso.
* **Headers:** `Authorization: Bearer <token_jwt>`
* **Response (200 OK - JSON):** Un elemento por módulo (no por permiso), con `idModuloPadre` para poder anidar sub-módulos en el menú.
```json
[
  {
    "id": 7,
    "nombre": "Cajas",
    "esAsignable": true,
    "idModuloPadre": null,
    "moduloPadre": null,
    "acciones": ["Ver", "Crear", "Anular"]
  },
  {
    "id": 8,
    "nombre": "Gastos",
    "esAsignable": true,
    "idModuloPadre": 7,
    "moduloPadre": { "id": 7, "nombre": "Cajas" },
    "acciones": ["Ver", "Crear"]
  },
  {
    "id": 10,
    "nombre": "EmisionTickets",
    "esAsignable": true,
    "idModuloPadre": null,
    "moduloPadre": null,
    "acciones": ["Ver", "Crear", "Editar", "Anular"]
  }
]
```
> Se excluyen los módulos anulados. Este endpoint **no** exige permiso a propósito: si dependiera de uno, ese permiso tendría que asignarse a todos y bastaría quitarlo por error para dejar a un usuario sin menú.

---

## 5. Acciones (`/acciones`)

### 5.1 `POST /acciones` (Crear Acción)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{
  "nombre": "Exportar"
}
```

* **Response (201 Created - JSON):**
```json
{
  "id": 5,
  "nombre": "Exportar"
}
```

---

### 5.2 `GET /acciones` (Listar Acciones)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Response (200 OK - JSON):**
```json
[
  { "id": 1, "nombre": "Ver" },
  { "id": 2, "nombre": "Crear" },
  { "id": 3, "nombre": "Editar" },
  { "id": 4, "nombre": "Anular" },
  { "id": 5, "nombre": "Exportar" }
]
```

---

### 5.3 `GET /acciones/:id` (Obtener Acción por ID)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 5,
  "nombre": "Exportar"
}
```

---

### 5.4 `PATCH /acciones/:id` (Actualizar Acción)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Editar'`
* **Path Params:** `id` (número entero)
* **Request Body (JSON):**
```json
{
  "nombre": "ExportarPDF"
}
```

* **Response (200 OK - JSON):**
```json
{
  "id": 5,
  "nombre": "ExportarPDF"
}
```

---

### 5.5 `DELETE /acciones/:id` (Eliminar Acción)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Anular'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 5,
  "nombre": "ExportarPDF"
}
```

---

## 6. Módulo-Acciones (`/modulo-acciones`)

### 6.1 `POST /modulo-acciones` (Vincular Módulo con Acción)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Editar'`
* **Request Body (JSON):**
```json
{
  "idModulo": 1,
  "idAccion": 4
}
```

* **Response (201 Created - JSON):**
```json
{
  "id": 12,
  "idModulo": 1,
  "idAccion": 4,
  "modulo": {
    "id": 1,
    "nombre": "Usuarios",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z"
  },
  "accion": {
    "id": 4,
    "nombre": "Anular"
  }
}
```

---

### 6.2 `GET /modulo-acciones` (Listar Asociaciones Módulo-Acción)
**Es la lista que debe alimentar la pantalla de asignación de permisos.** Por defecto devuelve **solo los vínculos asignables**: módulos activos y que no sean de infraestructura.

* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Query Params (Opcional):** `?incluirNoAsignables=true` para ver también los de módulos anulados o no asignables (administración y diagnóstico).
* **Response (200 OK - JSON):**
```json
[
  {
    "id": 12,
    "idModulo": 1,
    "idAccion": 4,
    "modulo": { "id": 1, "nombre": "Usuarios", "anulado": false, "esAsignable": true },
    "accion": { "id": 4, "nombre": "Anular" }
  }
]
```
> ⚠️ Un "seleccionar todos los permisos" en el frontend debe construirse con **esta** lista. Antes devolvía todos los vínculos, incluidos los de módulos anulados, y `POST /usuarios/:id/permisos` los rechazaba con `400`.

---

### 6.3 `GET /modulo-acciones/modulo/:idModulo` (Obtener Acciones por ID de Módulo)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Path Params:** `idModulo` (número entero)
* **Response (200 OK - JSON):**
```json
[
  {
    "id": 12,
    "idModulo": 1,
    "idAccion": 4,
    "accion": { "id": 4, "nombre": "Anular" }
  }
]
```

---

### 6.4 `GET /modulo-acciones/:id` (Obtener por ID)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 12,
  "idModulo": 1,
  "idAccion": 4,
  "modulo": { "id": 1, "nombre": "Usuarios", "anulado": false },
  "accion": { "id": 4, "nombre": "Anular" }
}
```

---

### 6.5 `DELETE /modulo-acciones/:id` (Eliminar Vinculación)
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Anular'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 12,
  "idModulo": 1,
  "idAccion": 4
}
```

---

## 7. Bitácora y Auditoría (`/bitacora`)

### 7.1 `GET /bitacora` (Listar Bitácora de Actividades)
Obtiene los registros de auditoría ordenados descendentemente por fecha en huso horario **UTC-6**.

* **Permiso requerido:** `Módulo: 'Bitacora'`, `Acción: 'Ver'`
* **Query Params (Todos opcionales):**
  - `idUsuario` (número): Filtrar por ID de usuario ejecutor.
  - `modulo` (texto): Filtra por módulo, por **coincidencia parcial** (`contains`), no por igualdad.
  - `accion` (texto): Filtra por tipo de acción, también por coincidencia parcial (ej. `INICIO_SESION`, `EMITIR_TICKET`, `ANULAR_DONACION`, `CIERRE_CAJA`, `ASIGNAR_PERMISOS`). Hay 45 acciones distintas registradas.
  - `fechaInicio` (ISO Date string): Filtrar desde fecha.
  - `fechaFin` (ISO Date string): Filtrar hasta fecha.
  - `pagina` (número, defecto `1`): Página a devolver.
  - `limite` (número, defecto `20`, máx. `200`): Registros por página.

> **`modulo` y `accion` son texto libre que escribe cada servicio al registrar, no claves foráneas.** `Bitacora.modulo` **no** es una FK a la tabla `Modulo` y sus valores no coinciden con ella: la bitácora escribe `Tickets`, `Auth`, `Gastos`, `TiposGasto` y `Modulos`, que no existen como módulo; y varios módulos (`Puestos`, `Guias`, `Atracciones`, `Paises`…) no tienen ni un registro.
>
> Los valores presentes hoy, por volumen: `Reportes`, `Tickets`, `Auth`, `Cajas`, `Donaciones`, `ActividadesParque`, `Usuarios`, `Gastos`, `TiposGasto`, `EmisionTickets`, `Modulos`, `Tarifas`.
>
> Por eso **no conviene poblar un selector de módulos con `GET /modulos`**: dejaría fuera `Tickets` —el segundo en volumen— y `Auth`, y ofrecería módulos sin ningún registro.
>
> Y como el filtro es `contains`, `?modulo=Tickets` devuelve **también** los de `EmisionTickets`. Es la única pareja que se solapa entre los valores actuales (`Gastos` no alcanza a `TiposGasto`, que va en singular).

* **Response (200 OK - JSON):** sobre paginado — ver [Paginación de listados](#paginación-de-listados).
```json
{
  "datos": [
    {
      "id": 15,
      "idUsuario": 1,
      "usuarioNombre": "Administrador General",
      "accion": "CREAR_USUARIO",
      "modulo": "Usuarios",
      "descripcion": "Se creo el nuevo usuario 'Carlos Mendoza' (carlos.mendoza@aktunkan.com) asignado al puesto 'Taquillero'.",
      "fecha": "2026-07-25T03:45:00.000Z",
      "usuario": {
        "id": 1,
        "nombre": "Administrador General",
        "correo": "admin@aktunkan.com",
        "puesto": {
          "id": 1,
          "nombre": "Administrador"
        }
      }
    },
    {
      "id": 14,
      "idUsuario": 2,
      "usuarioNombre": "Carlos Mendoza",
      "accion": "INICIO_SESION",
      "modulo": "Auth",
      "descripcion": "Inicio de sesión exitoso para el usuario 'Carlos Mendoza' (carlos.mendoza@aktunkan.com).",
      "fecha": "2026-07-25T03:40:12.000Z",
      "usuario": {
        "id": 2,
        "nombre": "Carlos Mendoza",
        "correo": "carlos.mendoza@aktunkan.com",
        "puesto": {
          "id": 2,
          "nombre": "Taquillero"
        }
      }
    }
  ],
  "total": 1627,
  "pagina": 1,
  "limite": 20
}
```
> Es la tabla que más crece del sistema. Antes topaba en 100 registros **sin forma de pedir los siguientes**; ahora `pagina` recorre el histórico completo y `total` dice cuántos hay.

---

### 7.2 `GET /bitacora/:id` (Obtener Registro de Bitácora por ID)
* **Permiso requerido:** `Módulo: 'Bitacora'`, `Acción: 'Ver'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 15,
  "idUsuario": 1,
  "usuarioNombre": "Administrador General",
  "accion": "CREAR_USUARIO",
  "modulo": "Usuarios",
  "descripcion": "Se creo el nuevo usuario 'Carlos Mendoza' (carlos.mendoza@aktunkan.com) asignado al puesto 'Taquillero'.",
  "fecha": "2026-07-25T03:45:00.000Z",
  "usuario": {
    "id": 1,
    "nombre": "Administrador General",
    "correo": "admin@aktunkan.com",
    "puesto": {
      "id": 1,
      "nombre": "Administrador"
    }
  }
}
```

---

## 8. Cajas (`/cajas`)

Módulo de apertura y cierre de caja. Solo puede existir **una caja abierta a la vez en todo el sistema**. Ni la apertura ni el cierre se pueden editar una vez creados — solo se pueden **anular**.

### 8.1 `POST /cajas/apertura` (Abrir Caja)
* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{
  "montoInicial": 500.00,
  "observaciones": "Fondo inicial de caja del turno matutino"
}
```
* **Response (201 Created - JSON):** Falla con `409 Conflict` si ya existe una caja abierta.
```json
{
  "id": 5,
  "idUsuario": 1,
  "montoInicial": "500.0000",
  "observaciones": "Fondo inicial de caja del turno matutino",
  "anulado": false,
  "fechaCreacion": "2026-08-13T14:00:00.000Z",
  "fechaActualizacion": "2026-08-13T14:00:00.000Z",
  "usuario": { "id": 1, "nombre": "Administrador General", "correo": "admin@aktunkan.com" },
  "estado": { "id": 1, "nombre": "Abierta" },
  "cierresCaja": [],
  "gastos": []
}
```

---

### 8.2 `GET /cajas` (Listar Aperturas)
* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Ver'`
* **Query Params (todos opcionales):** `estado=Abierta`, `fechaInicio`, `fechaFin`, `incluirAnulados=true`, `pagina` (default 1), `limite` (default 20, máx. 200)
* **Response (200 OK - JSON):** sobre paginado — ver [Paginación de listados](#paginación-de-listados). Cada elemento de `datos[]` tiene la misma forma que 8.1.

```json
{
  "datos": [ /* aperturas con la forma de 8.1 */ ],
  "total": 18,
  "pagina": 1,
  "limite": 20
}
```
> A quien no tiene `Cajas.Editar` se le siguen omitiendo `montoEsperado` y `diferencia` **en cada elemento de `datos[]`**. Ocultarlos quita campos, nunca filas: `total` cuenta lo mismo para el cajero y para el supervisor.

---

### 8.3 `GET /cajas/actual` (Obtener Caja Abierta Actual)
"No hay caja abierta" es un estado normal, no un error: siempre responde `200` con un objeto.

* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Ver'`
* **Response (200 OK - JSON):**
```json
{ "hayCajaAbierta": true, "caja": { "id": 5, "estado": { "nombre": "Abierta" } } }
```
```json
{ "hayCajaAbierta": false, "caja": null }
```
> ⚠️ **Cambio:** antes devolvía la caja directamente, o `null` cuando no había ninguna — y ese `null` viajaba como **cuerpo vacío sin `content-type`**, lo que hacía fallar a `response.json()` en el cliente con *"Unexpected end of JSON input"*. Ahora el cuerpo siempre es JSON válido; en el frontend hay que leer `data.caja` en lugar de la respuesta completa.

---

### 8.4 `GET /cajas/:id` (Detalle de una Apertura)
* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Ver'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):** Igual que 8.1, incluyendo `cierresCaja` y `gastos` asociados.

---

### 8.5 `GET /cajas/:id/arqueo` (Previsualizar Arqueo)
Calcula el monto esperado sin cerrar la caja, para revisión previa.

* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Editar'` — **es supervisión**, no lectura: quien cuenta el efectivo no debe ver esta cifra (ver [Control de arqueo](#control-de-arqueo-qué-ve-el-cajero-y-qué-ve-el-supervisor)).
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "idApertura": 5,
  "montoInicial": 500,
  "ventasEfectivo": 1250,
  "totalDonaciones": 100,
  "montoEsperado": 1850,
  "discrepanciaOffline": {
    "tickets": 2,
    "montoCobrado": "150.0000",
    "montoRecalculado": "170.0000",
    "diferencia": "-20.0000"
  }
}
```

**`discrepanciaOffline`** son las ventas offline en las que se cobró algo distinto de lo que correspondía según la tarifa vigente en el momento de la venta (ver sección 18.3). Es `null` cuando no hay ninguna. `diferencia` negativa = se cobró de menos.

> **No altera `montoEsperado`, y es a propósito.** El esperado es el dinero que debería estar en el cajón, y en el cajón está lo que se cobró. Si la discrepancia se restara, el arqueo cuadraría mal y un error de tarifa aparecería como si el cajero hubiera contado mal.
>
> Va como cifra aparte porque, sin ella, un cobro de menos **no deja ninguna huella**: el pago se registró por lo cobrado, el esperado coincide con lo contado, y nadie se entera nunca.

---

### 8.6 `POST /cajas/:id/cierre` (Cerrar Caja)
Calcula el arqueo, crea el registro de cierre (no editable) y marca la caja como `'Cerrada'`.

* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Crear'`
* **Path Params:** `id` (número entero, ID de la apertura)
* **Request Body (JSON):**
```json
{
  "montoContado": 1590.00,
  "observaciones": "Faltante detectado, se revisará con el cajero"
}
```
* **Response (201 Created - JSON):** Falla con `400 Bad Request` si la caja ya está cerrada o anulada.
```json
{
  "apertura": {
    "id": 5,
    "estado": { "id": 2, "nombre": "Cerrada" }
  },
  "cierre": {
    "id": 3,
    "idApertura": 5,
    "fechaCierre": "2026-08-13T20:00:00.000Z",
    "montoFinal": "1590.0000",
    "montoEsperado": "1600.0000",
    "diferencia": "-10.0000",
    "observaciones": "Faltante detectado, se revisará con el cajero",
    "anulado": false
  },
  "discrepanciaOffline": null
}
```

> `discrepanciaOffline` solo viaja para un supervisor, con el mismo criterio que `montoEsperado`: quien cobró de menos no debería ver si el sistema lo detectó.

#### Bloqueo por lote offline pendiente

Si la caja tiene un **lote offline activo**, el cierre responde **`409 Conflict`**:

```json
{
  "codigo": "LOTE_OFFLINE_PENDIENTE",
  "idLote": 7,
  "foliosReservados": 88,
  "message": "La caja tiene el lote offline 7 activo, con 88 folios sin liquidar. Suba la cola de ventas del dispositivo y concilie el lote antes de cerrar."
}
```

Una venta offline de las 10:00 que se sube a las 16:00 no puede entrar en una caja cerrada a las 14:00 sin corromper un arqueo ya guardado. El taquillero cierra su turno con conexión, que es cuando de todos modos cuenta el efectivo. **Conciliado el lote (18.4), la caja cierra normalmente.**

> **Solo bloquean los lotes vigentes.** Un lote **vencido** no traba el cierre: se concilia automáticamente y la caja cierra. De lo contrario esa caja quedaría imposible de cerrar, esperando que alguien concilie un lote que el dispositivo ya reemplazó — y como solo puede haber una caja abierta en todo el sistema, se bloquearía la operación entera.
>
> Cerrar con un lote vencido **no requiere supervisión** ni `forzarLoteOffline`: no hay nada que decidir. Queda en Bitácora como `CONCILIAR_LOTE_OFFLINE_VENCIDO`.

**Salida de emergencia** — dispositivo perdido, roto o que no va a volver:

```json
{ "montoContado": 1590.00, "forzarLoteOffline": true }
```

* **Exige `Cajas` + `Editar`** (supervisión). Un cajero recibe **`403`**.
* Invalida el lote y sus folios pendientes, y queda en Bitácora como `FORZAR_CIERRE_LOTE_OFFLINE`.
* **Destruye las ventas que el dispositivo no haya subido:** ese dinero queda cobrado sin ticket que lo respalde.

> **El permiso es `Editar` y no `Anular` por la misma razón que anular un cierre.** El cajero **sí** tiene `Cajas.Anular` —lo usa para tickets y aperturas equivocadas—, así que pedir `Anular` acá le permitiría descartar sus propias ventas offline pendientes y cerrar la caja sin ellas.

---

### 8.7 `PATCH /cajas/:id/cierre/anular` (Anular Cierre y Reabrir Caja)
Anula el cierre vigente y revierte el estado de la caja a `'Abierta'`, para corregir un cierre hecho por error.

* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Editar'` — **es supervisión**. Si el cajero pudiera anular su propio cierre, podría cerrar, ver la diferencia, anular y volver a cerrar cuadrado.
* **Path Params:** `id` (número entero, ID de la apertura)
* **Response (200 OK - JSON):** Falla con `400 Bad Request` si la caja no tiene un cierre vigente, y con `409 Conflict` si ya existe otra caja abierta (reabrir dejaría dos cajas abiertas).
* Un cierre anulado **no se puede reactivar**: para volver a cerrar la caja se emite un cierre nuevo.
```json
{
  "id": 5,
  "estado": { "id": 1, "nombre": "Abierta" }
}
```

---

### 8.8 `DELETE /cajas/:id` (Anular Apertura)
Anula una apertura hecha por error. Solo permitido mientras la caja sigue `'Abierta'`.

* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Anular'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):** Falla con `400 Bad Request` si la caja ya está `'Cerrada'` (primero debe anularse el cierre).
```json
{
  "id": 5,
  "anulado": true
}
```

---

### 8.9 `GET /cajas/cierres` (Historial de cierres)
Vista de supervisión: todos los cierres con su arqueo, incluidos los anulados —que son la señal de que una caja se reabrió para corregir un monto.

* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Editar'`
* **Query Params (todos opcionales):** `idUsuario` (quien abrió la caja), `fechaInicio`, `fechaFin`, `soloAnulados=true`, `incluirAnulados=true`, `pagina` (default 1), `limite` (default 20, máx. 200)
* **Response (200 OK - JSON):** Las métricas se agregan en el servidor sobre el filtro aplicado.
```json
{
  "datos": [
    {
      "id": 12,
      "idApertura": 15,
      "fechaCierre": "2026-08-15T01:30:00.000Z",
      "montoFinal": "550.0000",
      "montoEsperado": "635.0000",
      "diferencia": "-85.0000",
      "observaciones": "Faltante detectado",
      "anulado": false,
      "aperturaCaja": {
        "id": 15,
        "montoInicial": "500.0000",
        "usuario": { "id": 4, "nombre": "Giselle Pereira", "correo": "..." },
        "estado": { "id": 2, "nombre": "Cerrada" }
      }
    }
  ],
  "total": 12,
  "pagina": 1,
  "limite": 20,
  "metricas": {
    "totalCierres": 12,
    "totalContado": "6100.0000",
    "totalEsperado": "6185.0000",
    "diferenciaAcumulada": "-85.0000"
  }
}
```
> `diferenciaAcumulada` negativa es faltante acumulado; positiva, sobrante.
>
> La ruta se declara antes de `/cajas/:id` para que no la capture el parámetro numérico.

---

## 9. Gastos (`/gastos`)

Registra gastos contra la **caja abierta actual** — el cliente no envía `idAperturaCaja`, se asocia automáticamente. Los gastos vigentes se descuentan en el arqueo de `Cajas`.

### 9.1 `POST /gastos` (Registrar Gasto)
* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{
  "idTipoGasto": 1,
  "descripcion": "Compra de insumos de limpieza",
  "monto": 150.00
}
```
* **Response (201 Created - JSON):** Falla con `400 Bad Request` si no hay caja abierta.
```json
{
  "id": 10,
  "idTipoGasto": 1,
  "idAperturaCaja": 5,
  "idUsuario": 1,
  "descripcion": "Compra de insumos de limpieza",
  "monto": "150.0000",
  "anulado": false,
  "fechaCreacion": "2026-08-13T15:00:00.000Z",
  "fechaActualizacion": "2026-08-13T15:00:00.000Z",
  "tipoGasto": { "id": 1, "nombre": "Insumos", "anulado": false }
}
```

---

### 9.2 `GET /gastos` (Listar Gastos)
* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Ver'`
* **Query Params (Opcionales):** `?idAperturaCaja=5`, `?incluirAnulados=true`
* **Response (200 OK - JSON):** Arreglo de objetos con la misma forma que 9.1.

---

### 9.3 `GET /gastos/:id` (Obtener Gasto por ID)
* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Ver'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):** Igual que 9.1.

---

### 9.4 `PATCH /gastos/:id` (Editar Gasto)
Solo permitido mientras la caja del gasto sigue **abierta**. El campo `anulado` no se acepta: para dar de baja se usa `DELETE /gastos/:id`.

* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Editar'`
* **Path Params:** `id` (número entero)
* **Request Body (JSON - Campos opcionales):**
```json
{
  "descripcion": "Compra de insumos de limpieza (corregido)",
  "monto": 160.00
}
```
* **Response (200 OK - JSON):** Igual que 9.1. Falla con `400 Bad Request` si la caja del gasto ya fue cerrada.

---

### 9.5 `DELETE /gastos/:id` (Anular Gasto)
Solo permitido mientras la caja del gasto sigue **abierta** (`400` en caso contrario).

* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Anular'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 10,
  "anulado": true
}
```

---

## 10. Tipos de Gasto (`/tipos-gasto`)

Catálogo usado por `Gastos`. Sigue el mismo patrón CRUD que `Puestos` (crear, listar, obtener, editar, activar, anular).

### 10.1 `POST /tipos-gasto` (Crear Tipo de Gasto)
* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{ "nombre": "Insumos" }
```
* **Response (201 Created - JSON):**
```json
{ "id": 1, "nombre": "Insumos", "anulado": false }
```

---

### 10.2 `GET /tipos-gasto` (Listar Tipos de Gasto)
* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Ver'`
* **Query Params (Opcional):** `?incluirAnulados=true`
* **Response (200 OK - JSON):**
```json
[{ "id": 1, "nombre": "Insumos", "anulado": false }]
```

---

### 10.3 `GET /tipos-gasto/:id` (Obtener Tipo de Gasto por ID)
* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Ver'`
* **Response (200 OK - JSON):**
```json
{ "id": 1, "nombre": "Insumos", "anulado": false, "_count": { "gastos": 3 } }
```

---

### 10.4 `PATCH /tipos-gasto/:id` (Actualizar Tipo de Gasto)
* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Editar'`
* **Request Body (JSON):**
```json
{ "nombre": "Insumos de limpieza" }
```

---

### 10.5 `PATCH /tipos-gasto/:id/activar` (Reactivar Tipo de Gasto)
* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Editar'`

---

### 10.6 `DELETE /tipos-gasto/:id` (Anular Tipo de Gasto)
* **Permiso requerido:** `Módulo: 'Gastos'`, `Acción: 'Anular'`
* **Response (200 OK - JSON):**
```json
{ "id": 1, "nombre": "Insumos de limpieza", "anulado": true }
```

---

## 11. Tickets (`/tickets`)

Emisión de boletos del parque. Reglas que aplica el servidor:

- **Requiere caja abierta.** Sin caja abierta no se puede vender (`400`).
- **El cliente nunca envía precios.** El servidor resuelve la tarifa vigente por atracción + origen + categoría. El payload solo lleva cantidades e identificadores.
- **El folio lo genera el servidor**: correlativo, único, y siempre **texto** (`TCK-2026-000123`). La serie es alfanumérica y configurable con `TICKET_SERIE`.
- **Guía sin carnet ⇒ dos tickets.** Se emiten dos registros independientes (visitante y guía) unidos por `idGrupoEmision`, cada uno con su folio, QR, monto y forma de pago. Si el guía tiene carnet, va incluido sin costo y su número de carnet **no** se expone en el pase.
- `nino_menor` siempre Q0. `centro_educativo` no está disponible para origen extranjero. El país es obligatorio si el origen es extranjero.

### 11.1 `POST /tickets/emitir` (Emitir Ticket)
* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{
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
  "guia": {
    "modo": "nuevo",
    "nombre": "Pedro Ak'abal",
    "tieneCarnet": false,
    "idOpcionPagoGuia": 2
  }
}
```
> `guia` es opcional. Con `modo: "existente"` se envía `idGuia`; con `modo: "nuevo"` se envían `nombre`, `tieneCarnet` y `numeroCarnet` (obligatorio si `tieneCarnet: true`). Un guía nuevo queda registrado en el catálogo.
>
> ⚠️ **Nombres de guía repetidos se rechazan con `409`** y la emisión completa falla. El mensaje incluye el ID del guía existente para que el frontend ofrezca seleccionarlo:
> `"Ya existe un guía activo llamado 'Carlos Garcia' (ID 14). Selecciónelo de la lista en vez de crear uno nuevo."`

* **Response (201 Created - JSON):**
```json
{
  "idGrupoEmision": 12,
  "montoVisitantes": "70",
  "montoGuia": "15",
  "montoTotalGeneral": "85",
  "tickets": [
    {
      "id": 31,
      "numeroTicket": "TCK-2026-000045",
      "tipoTicket": "VISITANTE",
      "nombre": "Familia Rodríguez",
      "cantidadPersonas": 5,
      "montoTotal": "70.0000",
      "qrFirma": "9f2a…",
      "qr": "{\"numeroTicket\":\"TCK-2026-000045\",\"firma\":\"9f2a…\"}",
      "atraccion": { "id": 1, "codigo": "cuevas", "nombre": "Cuevas Actun Kan" },
      "origen": { "id": 1, "codigo": "nacional", "nombre": "Nacional" },
      "pais": null,
      "visitantePorTickets": [
        { "idTipoVisitante": 1, "cantidad": 2, "precioUnitario": "20.0000", "subtotal": "40.0000" },
        { "idTipoVisitante": 2, "cantidad": 3, "precioUnitario": "10.0000", "subtotal": "30.0000" }
      ],
      "ticketPagos": [{ "idOpcionPago": 1, "monto": "70.0000" }]
    },
    {
      "id": 32,
      "numeroTicket": "TCK-2026-000046",
      "tipoTicket": "GUIA",
      "cantidadPersonas": 1,
      "montoTotal": "15.0000"
    }
  ]
}
```
> El campo `qr` es exactamente lo que debe codificarse en el código QR impreso. Los datos legibles del pase (nombre, personas, total) los arma el frontend con esta misma respuesta.

---

### 11.2 `GET /tickets` (Historial con filtros y métricas)
* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Ver'`
* **Query Params (todos opcionales):** `buscar` (nombre, folio o guía), `idAtraccion`, `idOpcionPago`, `idOrigen`, `idPais`, `fechaInicio`, `fechaFin`, `incluirAnulados=true`, `pagina` (default 1), `limite` (default 20, máx. 200)
* **Response (200 OK - JSON):** Las métricas se calculan en el servidor sobre el filtro aplicado, no solo sobre la página.
```json
{
  "datos": [ /* tickets con la misma forma que 11.1 */ ],
  "total": 128,
  "pagina": 1,
  "limite": 20,
  "metricas": {
    "totalTickets": 133,
    "ticketsVigentes": 12,
    "totalPersonas": 15,
    "montoRecaudado": "305.0000",
    "ticketsAnulados": 121,
    "montoAnulado": "3048.0000"
  }
}
```

> **`montoRecaudado` y `totalPersonas` nunca cuentan tickets anulados**, ni siquiera con `incluirAnulados=true`. Un ticket anulado no cobró nada ni dejó entrar a nadie, y ya salió del arqueo de su caja.

Igual que en donaciones, las cifras describen el mismo conjunto que el listado:

```
totalTickets = ticketsVigentes + ticketsAnulados
```

---

### 11.3 `POST /tickets/validar` (Control de acceso en taquilla)
Verifica la firma del QR y sella el primer uso. Cada intento, aceptado o rechazado, queda en Bitácora.

* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Editar'`
* **Request Body (JSON):** el contenido decodificado del QR.
```json
{ "numeroTicket": "TCK-2026-000045", "firma": "9f2a…" }
```
* **Respuestas:**
  - `200` — ingreso autorizado: `{ "valido": true, "mensaje": "Ingreso autorizado.", "ticket": { … } }`
  - `401` — firma inválida o alterada
  - `404` — el ticket no existe
  - `409` — ticket anulado, o **ya utilizado** (incluye la fecha de uso)

---

### 11.4 `GET /tickets/:id` y `DELETE /tickets/:id`
* **Ver:** `Módulo: 'EmisionTickets'`, `Acción: 'Ver'`. Devuelve el ticket con su `qr` listo para imprimir.
* **Anular:** `Módulo: 'EmisionTickets'`, `Acción: 'Anular'`. Baja lógica del ticket **y de sus pagos**, para que el ingreso salga del arqueo de caja. Solo con la caja de origen abierta.

---

### 11.5 Forma completa del ticket

Tanto `GET /tickets` (en cada elemento de `datos[]`) como `GET /tickets/:id` devuelven **todos** estos campos. Los ejemplos anteriores están abreviados; esta es la respuesta real:

```json
{
  "id": 51,
  "numeroTicket": "TCK-2026-000051",
  "idGrupoEmision": 38,
  "tipoTicket": "VISITANTE",
  "nombre": "Familia Rodríguez",
  "cantidadPersonas": 5,
  "montoTotal": "70.0000",
  "observaciones": "Grupo con reserva previa",
  "fechaCreacion": "2026-08-14T09:10:47.229Z",
  "fechaActualizacion": "2026-08-14T09:10:47.229Z",
  "anulado": false,
  "qrFirma": "9f2a…",
  "fechaUso": null,
  "idUsuarioUso": null,

  "atraccion":     { "id": 2, "codigo": "mariposario", "nombre": "Biblioteca ambiental" },
  "origen":        { "id": 1, "codigo": "nacional", "nombre": "Nacional" },
  "pais":          null,
  "tipoRecorrido": { "id": 1, "codigo": "corto", "nombre": "Recorrido corto (~45 minutos)" },
  "guia":          { "id": 4, "nombre": "Carlos Garcia", "tieneCarnet": true },
  "usuario":       { "id": 3, "nombre": "Manuel Castellanos", "correo": "..." },

  "visitantePorTickets": [
    {
      "idTipoVisitante": 1,
      "cantidad": 2,
      "precioUnitario": "20",
      "subtotal": "40",
      "tipoVisitantes": { "id": 1, "codigo": "adulto", "nombre": "Adulto" }
    },
    {
      "idTipoVisitante": 2,
      "cantidad": 3,
      "precioUnitario": "10",
      "subtotal": "30",
      "tipoVisitantes": { "id": 2, "codigo": "nino", "nombre": "Niño (7 años o más)" }
    }
  ],

  "ticketPagos": [
    { "idOpcionPago": 1, "monto": "70.0000", "opcionPago": { "nombre": "Efectivo", "esEfectivo": true } }
  ]
}
```

Notas para el frontend:

- **`visitantePorTickets` es el desglose por categoría**: cuántos de cada tipo, el **precio unitario aplicado** y el subtotal. Es histórico — refleja lo que se cobró, no la tarifa vigente hoy. Los tickets de tipo `GUIA` traen este arreglo **vacío** (una persona, sin desglose).
- **Usa `tipoVisitantes.codigo`** (`adulto`, `nino`, `nino_menor`, `centro_educativo`) para cualquier lógica; `nombre` es texto editable.
- **`guia` llega en los dos tickets** de una emisión con guía, incluido el de tipo `GUIA`. Es `null` cuando la venta no llevó guía.
- **`guia.tieneCarnet` refleja el estado actual** del guía en el catálogo, no el que tenía al emitirse. Para saber si se le cobró aparte, la fuente fiable es la existencia de un segundo ticket con `tipoTicket: "GUIA"` en el mismo `idGrupoEmision`.
- **`idGrupoEmision`** empareja el ticket del visitante con el de su guía.
- **`pais`** solo viene cuando el origen es extranjero.
- Los montos son **cadenas**, no números (`Decimal(18,4)` de Prisma): conviértelos con `Number()` antes de operar.

---

### 11.6 `GET /tickets/:id/pdf` (Pase de acceso imprimible)
Devuelve el pase listo para descargar e imprimir.

* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Ver'`
* **Response:** `application/pdf`, con `Content-Disposition: inline; filename="TCK-2026-000051.pdf"` (el navegador lo previsualiza y el usuario decide descargar o imprimir).

Características:

- **Página de 80 mm de ancho**, alto ajustado al contenido: sirve en impresora térmica de taquilla y en una de oficina.
- **Sin fondos de color**: las cajas van solo con contorno, porque en térmica cualquier relleno sale como mancha oscura.
- **Color según el tipo de pase** — verde para el visitante, ámbar para el guía, con marco e insignia `GUÍA SIN CARNET`. En térmica sale en blanco y negro, pero el PDF descargado se distingue de un vistazo.
- Incluye el **desglose por categoría** y el QR con el mismo payload que espera `POST /tickets/validar`.
- Cuando la emisión genera dos tickets, **cada uno tiene su propio PDF**: se piden por separado con su `id`.

---

## 12. Tarifas (`/tarifas`)

Editar un precio **no sobrescribe** la fila: cierra la vigencia de la tarifa actual y crea una nueva. Los tickets ya vendidos conservan el precio con el que se emitieron (`VisitantePorTicket.precioUnitario`).

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/tarifas` | `EmisionTickets` / `Ver` | Tarifas vigentes (atracción + origen + categoría). **Sin paginar**: alimenta el formulario de emisión |
| GET | `/tarifas/historico` | `EmisionTickets` / `Ver` | Historial, **paginado**. Filtros: `idAtraccion`, `idOrigen`, `pagina`, `limite` |
| GET | `/tarifas/guia` | `EmisionTickets` / `Ver` | Tarifa vigente del ticket de guía sin carnet |
| PATCH | `/tarifas` | `EmisionTickets` / `Editar` | `{ idAtraccion, idOrigen, idTipoVisitante, precio }` |
| PATCH | `/tarifas/guia` | `EmisionTickets` / `Editar` | `{ precio }` |

Validación: se rechaza precio ≤ 0 salvo en la categoría `nino_menor`, la única que admite Q0.

`GET /tarifas/historico` devuelve el sobre paginado (`pagina` default 1, `limite` default 20, máx. 200) — ver [Paginación de listados](#paginación-de-listados):

```json
{
  "datos": [ /* tarifas, de la más reciente a la más antigua por atracción y origen */ ],
  "total": 15,
  "pagina": 1,
  "limite": 20
}
```
> `GET /tarifas` (vigentes) **no** se pagina: es el catálogo que llena el formulario de emisión y debe venir completo. Sigue devolviendo un arreglo plano.
>
> Los filtros pasaron a validarse con un DTO: `?idAtraccion=abc` ahora responde `400` en lugar de ignorarse.

---

## 13. Catálogos de Tickets — `GET /tickets/catalogos`

Atracciones, orígenes, países, tipos y formas de pago **no tienen CRUD propio**: son datos de configuración que solo alimentan el formulario de emisión. Se sirven todos en **una sola llamada** y se administran por seed (`prisma/seed-tickets.ts`).

* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Ver'`
* **Response (200 OK - JSON):**
```json
{
  "atracciones": [{ "id": 1, "codigo": "cuevas", "nombre": "Cuevas Actun Kan" }],
  "origenes": [
    { "id": 1, "codigo": "nacional", "nombre": "Nacional" },
    { "id": 2, "codigo": "extranjero", "nombre": "Extranjero" }
  ],
  "paises": [{ "id": 59, "nombre": "España", "codigoIso": "ESP" }],
  "tiposVisitante": [
    { "id": 1, "codigo": "adulto", "nombre": "Adulto" },
    { "id": 2, "codigo": "nino", "nombre": "Niño (7 años o más)" },
    { "id": 3, "codigo": "nino_menor", "nombre": "Niño menor de 7 años" },
    { "id": 4, "codigo": "centro_educativo", "nombre": "Centro educativo (nivel primario)" }
  ],
  "tiposRecorrido": [{ "id": 1, "codigo": "corto", "nombre": "Recorrido corto (~45 minutos)" }],
  "opcionesPago": [
    { "id": 1, "nombre": "Efectivo", "esEfectivo": true },
    { "id": 2, "nombre": "Tarjeta", "esEfectivo": false }
  ],
  "guias": [{ "id": 7, "nombre": "Juan Tecún", "tieneCarnet": true }],
  "tarifas": [
    { "idAtraccion": 1, "idOrigen": 1, "idTipoVisitante": 1, "precio": "20.0000" }
  ],
  "precioTicketGuia": "15.0000"
}
```

Notas de uso:
- **`codigo` es la clave estable** de las reglas de negocio (`nino_menor` siempre Q0, `centro_educativo` no aplica a extranjero). `nombre` es solo presentación.
- **`tarifas` es únicamente para que el formulario muestre el total al usuario.** El servidor vuelve a resolver el precio al emitir, así que un cliente manipulado no puede alterar lo que se cobra.
- **Guatemala viene en `paises`**; excluirla del selector de extranjeros es cosa del frontend.
- Los **guías nuevos se crean dentro de `POST /tickets/emitir`** (bloque `guia.modo: "nuevo"`), no por un endpoint aparte. Para consultarlos, corregirlos o darlos de baja ver la sección 14.
- Para **editar precios** sí hay endpoints: ver sección 12 (`/tarifas`).
- `/tipos-gasto` sigue existiendo aparte porque pertenece al sub-módulo `Gastos` de `Cajas`, no a la emisión de tickets.

---

## 14. Guías (`/guias`)

Catálogo de guías acompañantes. **No tiene alta independiente**: un guía nuevo se registra dentro de `POST /tickets/emitir` (bloque `guia.modo: "nuevo"`), que es donde el taquillero lo captura de verdad. Estos endpoints sirven para consultarlos, corregirlos y darlos de baja.

Todos exigen el módulo **`EmisionTickets`**.

| Método | Ruta | Acción | Descripción |
|---|---|---|---|
| GET | `/guias` | `Ver` | Listado **paginado**. Query: `buscar` (filtra por nombre), `incluirAnulados=true`, `pagina`, `limite` |
| GET | `/guias/:id` | `Ver` | Detalle, con `_count.tickets` (cuántos tickets tiene asociados) |
| PATCH | `/guias/:id` | `Editar` | Corregir `nombre`, `tieneCarnet` y `numeroCarnet` |
| PATCH | `/guias/:id/activar` | `Editar` | Reactivar un guía anulado |
| DELETE | `/guias/:id` | `Anular` | Baja lógica: desaparece del selector, los tickets emitidos conservan la referencia |

* **Response de `GET /guias` (200 OK - JSON):** sobre paginado — ver [Paginación de listados](#paginación-de-listados).
```json
{
  "datos": [
    {
      "id": 14,
      "nombre": "Carlos Garcia",
      "tieneCarnet": true,
      "numeroCarnet": "GTK-1002",
      "anulado": false,
      "fechaCreacion": "2026-08-14T22:41:10.000Z",
      "fechaActualizacion": "2026-08-15T18:20:00.000Z"
    }
  ],
  "total": 3,
  "pagina": 1,
  "limite": 20
}
```
> El selector de guías debe leer `.datos`. Si necesita la lista entera de una vez, pida `?limite=200`.

* **Response de `GET /guias/:id` (200 OK - JSON):** un solo objeto con esa misma forma.
```json
{
  "id": 14,
  "nombre": "Carlos Garcia",
  "tieneCarnet": true,
  "numeroCarnet": "GTK-1002",
  "anulado": false,
  "fechaCreacion": "2026-08-14T22:41:10.000Z",
  "fechaActualizacion": "2026-08-15T18:20:00.000Z"
}
```

Reglas:

- **Nombres duplicados se rechazan con `409`** entre guías activos, tanto al crear durante la emisión como al renombrar. Guardar un guía con su mismo nombre no genera conflicto consigo mismo.
- **`numeroCarnet` es obligatorio si `tieneCarnet: true`** (`400` en caso contrario). Al poner `tieneCarnet: false` el número se limpia automáticamente.
- **`/activar` existe porque no hay alta independiente**: sin él, un guía anulado por error quedaría irrecuperable desde la API.
- El **número de carnet nunca se imprime en el pase**, solo se guarda internamente.

---

## 15. Donaciones (`/donaciones`)

Registro de donaciones recibidas en ventanilla. **Solo se aceptan en efectivo** y se entrega un **recibo no contable** en PDF con folio correlativo.

Reglas del módulo:

- **Exige caja abierta.** La donación es efectivo que entra al mismo cajón que las ventas, así que **suma al arqueo**. Sin esta regla, cada donación aparecería como sobrante al cerrar la caja.
- **El recibo no se edita, solo se anula.** Igual que los tickets: un documento entregado es inmutable. Por eso el módulo no usa la acción `'Editar'`.
- **Anular exige que la caja de origen siga abierta**, porque hacerlo después del cierre alteraría de forma retroactiva un arqueo ya guardado.
- **El donante puede ser anónimo**: solo el monto es obligatorio.

**Permisos:** módulo `Donaciones` con las acciones `Ver`, `Crear` y `Anular`. Registrar con `npx ts-node prisma/seed-donaciones.ts`.

---

### 15.1 `POST /donaciones` (Registrar donación)
* **Permiso requerido:** `Módulo: 'Donaciones'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{
  "monto": 250.50,
  "nombreDonante": "Fundación Verde",
  "observaciones": "Aporte para conservación"
}
```
> Solo `monto` es obligatorio. Sin `nombreDonante`, el recibo sale a nombre de **"Donante anónimo"**.

* **Response (201 Created - JSON):**
```json
{
  "id": 30,
  "numeroRecibo": "DON-2026-000001",
  "idAperturaCaja": 16,
  "idUsuario": 3,
  "nombreDonante": "Fundación Verde",
  "monto": "250.5000",
  "observaciones": "Aporte para conservación",
  "anulado": false,
  "motivoAnulacion": null,
  "fechaCreacion": "2026-08-15T20:10:00.000Z",
  "fechaActualizacion": "2026-08-15T20:10:00.000Z",
  "usuario": { "id": 3, "nombre": "Jose Sandoval", "correo": "..." },
  "aperturaCaja": { "id": 16, "fechaCreacion": "2026-08-15T18:00:00.000Z" }
}
```
> Falla con `400` si no hay caja abierta o si se cerró durante la operación.

**Folio:** serie propia `DON`, con su contador por año, independiente de la numeración de tickets. Es **siempre texto** (`DON-2026-000001`), así que los listados se ordenan por fecha, nunca por folio.

---

### 15.2 `GET /donaciones` (Listado de recibos)
* **Permiso requerido:** `Módulo: 'Donaciones'`, `Acción: 'Ver'`
* **Query Params (todos opcionales):** `buscar` (folio o nombre del donante), `idUsuario`, `idAperturaCaja`, `fechaInicio`, `fechaFin`, `incluirAnulados=true`, `pagina` (default 1), `limite` (default 20, máx. 200)
* **Response (200 OK - JSON):** Las métricas se agregan en el servidor sobre el filtro aplicado.
```json
{
  "datos": [ /* recibos con la misma forma que 15.1 */ ],
  "total": 2,
  "pagina": 1,
  "limite": 20,
  "metricas": {
    "totalRecibos": 25,
    "recibosVigentes": 1,
    "montoRecaudado": "100.0000",
    "recibosAnulados": 24,
    "montoAnulado": "683.5000"
  }
}
```

> **`montoRecaudado` nunca cuenta recibos anulados**, ni siquiera con `incluirAnulados=true`. Un recibo anulado no recaudó nada: ese dinero salió del arqueo al anularlo (15.6). Si el total lo sumara, bastaría marcar la casilla de anulados para ver una recaudación que no existe.
>
> `montoAnulado` y `recibosAnulados` se exponen aparte para que la diferencia sea explicable en pantalla en vez de parecer un error de cuadre.

**Las cifras describen el mismo conjunto que el listado**, así que siempre se cumple:

```
totalRecibos = recibosVigentes + recibosAnulados
```

Sin `incluirAnulados=true`, `recibosAnulados` y `montoAnulado` son `0` — los anulados no están en la lista, así que tampoco se cuentan.

---

### 15.3 `GET /donaciones/:id` (Detalle del recibo)
* **Permiso requerido:** `Módulo: 'Donaciones'`, `Acción: 'Ver'`
* **Response (200 OK - JSON):** Igual que 15.1. Devuelve `404` si no existe.

---

### 15.4 `GET /donaciones/:id/pdf` (Recibo imprimible)
* **Permiso requerido:** `Módulo: 'Donaciones'`, `Acción: 'Ver'`
* **Response:** `application/pdf`, con `Content-Disposition: inline; filename="DON-2026-000001.pdf"`

Mismo formato que el pase de acceso —**80 mm de ancho**, alto ajustado al contenido, sin fondos de color para que la impresora térmica no lo saque manchado— con dos diferencias:

- **Acento azul**, para distinguirlo de un vistazo del pase de visitante (verde) y del de guía (ámbar).
- Lleva al pie, de forma visible, **"DOCUMENTO NO CONTABLE — Este recibo no tiene validez fiscal ni sustituye a una factura."**

Si el recibo está anulado, el PDF sale en **rojo** y con el sello **"RECIBO ANULADO"**.

No lleva código QR: es un comprobante de entrega, no un pase de acceso.

---

### 15.5 `DELETE /donaciones/:id` (Anular recibo)
Baja lógica. El recibo deja de contar en el arqueo, pero la fila se conserva.

* **Permiso requerido:** `Módulo: 'Donaciones'`, `Acción: 'Anular'`
* **Request Body (JSON - opcional):**
```json
{ "motivo": "Error de captura" }
```
> El motivo queda guardado en `motivoAnulacion` y en la Bitácora.

* **Response (200 OK - JSON):** El recibo con `anulado: true`.
* Falla con `400` si ya estaba anulado o si **la caja de origen ya se cerró**.

---

### 15.6 Efecto en el arqueo de caja

El monto esperado pasa a incluir las donaciones:

```
montoEsperado = montoInicial + ventas en efectivo + donaciones − gastos
```

`GET /cajas/:id/arqueo` (permiso `Cajas` + `Editar`) devuelve ahora el desglose:

```json
{
  "idApertura": 16,
  "montoInicial": 500,
  "ventasEfectivo": 0,
  "totalDonaciones": 300.5,
  "totalGastos": 0,
  "montoEsperado": 800.5
}
```

Anular un recibo lo descuenta de inmediato: solo cuentan las donaciones **no anuladas** de esa caja.

---

## 16. Actividades del Parque (`/actividades`)

Planificación y difusión interna de actividades. Un usuario **publica** una actividad y define la **ventana de tiempo** durante la cual el resto la ve.

Reglas del módulo:

- **La autoría manda sobre el permiso.** Editar, anular, subir y borrar imágenes son exclusivos del **autor** de la publicación. Cualquier otro usuario recibe `403`, aunque tenga la acción `Editar` o `Anular`. El permiso habilita publicar y mantener lo propio, no tocar lo ajeno.
- **El autor no se puede cambiar.** Es lo que define quién puede editar; permitir reasignarlo sería una forma de ceder ese control.
- **Ventana de visibilidad.** `fechaInicio` marca desde cuándo la ven los demás; `fechaFin` hasta cuándo. **Sin `fechaFin`, la publicación no expira.**
- **Fuera de la ventana desaparece para los demás** (`404`), pero **el autor la sigue viendo**, marcada como `expirada` o `programada`, para poder reprogramarla en lugar de tener que republicarla.
- **No hay exclusión por usuario:** toda persona con el permiso `Ver` ve las publicaciones vigentes. La visibilidad se controla únicamente con las fechas.
- **Anular es baja lógica** (`anulado: true`); la fila y sus imágenes se conservan.
- **Responsable opcional** (`idUsuarioResponsable`): quien ejecuta la actividad, que puede no ser quien la publica. No otorga permiso de edición.

**Permisos:** módulo `ActividadesParque` con las acciones `Ver`, `Crear`, `Editar` y `Anular`. Registrar con `npx ts-node prisma/seed-actividades.ts`.

| Acción | Habilita |
|---|---|
| `Ver` | Listar y consultar publicaciones vigentes, y descargar sus imágenes |
| `Crear` | Publicar una actividad nueva |
| `Editar` | Editar **las propias** y administrar sus imágenes |
| `Anular` | Anular **las propias** |

---

### 16.1 `POST /actividades` (Publicar actividad)
* **Permiso requerido:** `Módulo: 'ActividadesParque'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{
  "nombreActividad": "Jornada de reforestación",
  "descripcionActividad": "Siembra de 200 árboles en el sector norte. Llevar guantes.",
  "fechaInicio": "2026-08-20T14:00:00.000Z",
  "fechaFin": "2026-08-30T23:59:00.000Z",
  "idSectorParque": 1,
  "idUsuarioResponsable": 5
}
```

| Campo | Obligatorio | Reglas |
|---|---|---|
| `nombreActividad` | Sí | Texto, de 3 a 255 caracteres |
| `descripcionActividad` | Sí | Texto, máximo 5000 caracteres |
| `fechaInicio` | Sí | ISO 8601. Desde cuándo se muestra a los demás |
| `fechaFin` | No | ISO 8601, **posterior** a `fechaInicio`. Omitirla = no expira |
| `idSectorParque` | No | Debe existir y no estar anulado |
| `idUsuarioResponsable` | No | Debe existir y no estar anulado |

> El **autor se toma del token**, nunca del body. Enviar `idUsuarioAutor` devuelve `400` (el `ValidationPipe` rechaza campos no declarados).

* **Response (201 Created - JSON):** Ver la forma completa en 16.6.
* **Errores:** `400` si `fechaFin` no es posterior a `fechaInicio`, o si el sector o el responsable no existen o están anulados.

---

### 16.2 `GET /actividades` (Listado)
* **Permiso requerido:** `Módulo: 'ActividadesParque'`, `Acción: 'Ver'`
* **Query Params (todos opcionales):**

| Parámetro | Efecto |
|---|---|
| `buscar` | Busca en nombre y descripción |
| `idSectorParque` | Filtra por sector |
| `idUsuarioAutor` | Filtra por autor |
| `soloMias=true` | Solo las publicaciones del usuario autenticado |
| `incluirAnuladas=true` | Suma las anuladas **propias**. Las ajenas anuladas no se muestran nunca |
| `soloAnuladas=true` | Devuelve **solo** las anuladas, para una vista de papelera. Tiene prioridad sobre `incluirAnuladas` |
| `incluirExpiradas=true` | **Sin efecto**, se conserva por compatibilidad (ver abajo) |
| `pagina` | Por defecto `1` |
| `limite` | Por defecto `20`, máximo `100` |

* **Response (200 OK - JSON):**
```json
{
  "datos": [ /* actividades con la forma de 16.6 */ ],
  "total": 2,
  "pagina": 1,
  "limite": 20
}
```

Ordenado por `fechaInicio` descendente. **Un mismo listado devuelve distinto `total` según quién pregunte**: el autor ve además sus publicaciones expiradas y programadas.

> **El listado nunca muestra lo que el detalle oculta.** Ningún parámetro de consulta permite ver publicaciones ajenas anuladas o fuera de su ventana: lo que `GET /actividades/:id` responde con `404`, el listado tampoco lo devuelve. **El frontend no necesita filtrar nada del lado del cliente** — y no debe hacerlo, porque `total` se calcula con el mismo filtro que las filas y un filtrado adicional en pantalla desalinearía la paginación.
>
> `incluirExpiradas` quedó **sin efecto**: las publicaciones propias fuera de su ventana ya vienen siempre, y las ajenas nunca. Se mantiene aceptado para no romper a los clientes que aún lo envían (`forbidNonWhitelisted` respondería `400` si se quitara del DTO). Puede dejar de enviarlo.

**Vista de papelera:** `?soloAnuladas=true` devuelve únicamente las anuladas. Como las anuladas ajenas no se muestran nunca, en la práctica equivale a *"mis publicaciones anuladas"* — un tercero que lo use recibe una lista vacía, aunque agregue `idUsuarioAutor`. Tiene **prioridad sobre `incluirAnuladas`**, mismo criterio que `soloAnulados` en el historial de cierres de caja (sección 8.9). Se combina con el resto de filtros: `?soloAnuladas=true&buscar=jornada` busca dentro de la papelera.

> Ambos parámetros comparan contra la cadena exacta `'true'`. Cualquier otro valor (`1`, `si`, `TRUE`) se ignora y el listado se comporta como si no se hubiera enviado.

---

### 16.3 `GET /actividades/:id` (Detalle)
* **Permiso requerido:** `Módulo: 'ActividadesParque'`, `Acción: 'Ver'`
* **Response (200 OK - JSON):** Ver 16.6.
* **Errores:** `404` si no existe, y también si la publicación está **fuera de su ventana o anulada y quien consulta no es el autor**. Se responde `404` y no `403` a propósito: para un tercero, una publicación fuera de su ventana simplemente no existe.

---

### 16.4 `PATCH /actividades/:id` (Editar) y `DELETE /actividades/:id` (Anular)
* **Permisos:** `Editar` y `Anular` respectivamente, **y ser el autor**.
* **Body de `PATCH`:** los mismos campos de 16.1, todos opcionales. Enviar `"fechaFin": null` **quita** la expiración.
* **Response (200 OK - JSON):** La actividad actualizada (16.6).
* **Errores:**
  * `403` — `"Solo el autor de la publicación puede modificarla o anularla."`
  * `400` — al editar una publicación anulada, al anular una ya anulada, o si la ventana queda invertida.
  * `404` — la actividad no existe.

`DELETE` es baja lógica: deja `anulado: true` y la publicación desaparece para los demás.

---

### 16.5 Imágenes

Las imágenes se guardan **en disco**, en `<UPLOADS_DIR>/actividades`; en la base queda solo el nombre del archivo. Así una fila pesa unos cientos de bytes en vez de megabytes, y los backups y las consultas no cargan con los binarios.

El nombre del archivo **lo genera el servidor** (`<timestamp>-<16 hex><ext>`). El nombre que envía el cliente se conserva solo como dato (`nombreOriginal`) y nunca se usa como ruta: `../../.env` quedaría guardado como `1787040704589-ecc7367c2a1f2153.img`.

| Restricción | Valor |
|---|---|
| Formatos aceptados | `image/jpeg`, `image/png`, `image/webp`, `image/gif` |
| Tamaño máximo | 5 MB por archivo |
| Cantidad | Sin límite; se ordenan por el campo `orden` (0, 1, 2…) |

#### `POST /actividades/:id/imagenes` (Subir imagen)
* **Permiso requerido:** `Módulo: 'ActividadesParque'`, `Acción: 'Editar'`, **y ser el autor**
* **Request:** `multipart/form-data` con el archivo en el campo **`imagen`**.

```js
const fd = new FormData();
fd.append('imagen', archivo);
await fetch(`/actividades/${id}/imagenes`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` }, // sin Content-Type: lo pone el navegador
  body: fd,
});
```

* **Response (201 Created - JSON):**
```json
{
  "id": 7,
  "archivo": "1787040704507-50052835f0a199f6.png",
  "nombreOriginal": "reforestacion.png",
  "mimeType": "image/png",
  "orden": 0
}
```
* **Errores:** `400` si el formato no está permitido o supera los 5 MB; `403` si no es el autor.

#### `GET /actividades/:id/imagenes/:idImagen` (Descargar imagen)
* **Permiso requerido:** `Módulo: 'ActividadesParque'`, `Acción: 'Ver'`
* **Response:** el binario, con `Content-Type` del archivo y `Cache-Control: private, max-age=86400`.

Va por endpoint y **no** como archivo estático justamente para que respete el permiso y la ventana de visibilidad: si la publicación no es visible para quien pide, la imagen tampoco lo es (`404`).

> Como exige el header `Authorization`, un `<img src="...">` directo **no funciona**. En el frontend hay que pedirla con `fetch`, convertirla a `blob` y usar `URL.createObjectURL(blob)` como `src`.

#### `DELETE /actividades/:id/imagenes/:idImagen` (Eliminar imagen)
* **Permiso requerido:** `Módulo: 'ActividadesParque'`, `Acción: 'Editar'`, **y ser el autor**
* **Response (200 OK - JSON):** `{ "mensaje": "Imagen eliminada.", "id": 7 }`

A diferencia del resto del sistema, esto **sí borra**: la fila de la imagen y el archivo del disco. Una imagen no es un registro contable, y conservar archivos huérfanos solo llenaría el disco. La actividad que la contiene sigue intacta.

---

### 16.6 Forma completa de la actividad

```json
{
  "id": 1,
  "idUsuarioAutor": 3,
  "idUsuarioResponsable": 5,
  "idSectorParque": 1,
  "nombreActividad": "Jornada de reforestación",
  "descripcionActividad": "Siembra de 200 árboles en el sector norte.",
  "fechaInicio": "2026-08-20T14:00:00.000Z",
  "fechaFin": "2026-08-30T23:59:00.000Z",
  "fechaCreacion": "2026-08-18T10:00:00.000Z",
  "fechaActualizacion": "2026-08-18T10:00:00.000Z",
  "anulado": false,

  "vigente": true,
  "expirada": false,
  "programada": false,
  "esAutor": true,

  "autor":       { "id": 3, "nombre": "Jose Sandoval", "correo": "..." },
  "responsable": { "id": 5, "nombre": "Ana López",     "correo": "..." },
  "sector":      { "id": 1, "nombre": "Sector Norte" },
  "imagenes": [
    {
      "id": 7,
      "archivo": "1787040704507-50052835f0a199f6.png",
      "nombreOriginal": "reforestacion.png",
      "mimeType": "image/png",
      "tamanoBytes": 23057,
      "orden": 0
    }
  ]
}
```

**Campos calculados por el servidor** — el frontend no debe recalcularlos comparando fechas:

| Campo | Significado |
|---|---|
| `vigente` | Está dentro de su ventana y no anulada. Es la que se muestra al público del módulo |
| `expirada` | Ya pasó su `fechaFin`. Solo la ve el autor |
| `programada` | Aún no llega su `fechaInicio`. Solo la ve el autor |
| `esAutor` | El usuario autenticado es el autor. Úselo para mostrar u ocultar los botones de editar, anular y subir imágenes |

> `esAutor` es una ayuda para la interfaz, no un control: el servidor verifica la autoría en cada operación de escritura.
>
> `fechaInicio` y `fechaFin` se comparan contra la **hora real** del servidor, no contra el reloj desplazado a UTC-6 que sella `fechaCreacion` en el resto del sistema. Envíelas siempre en ISO 8601 con zona (`...Z` o con desfase explícito).

---

## 17. Sectores del Parque (`/sectores`)

Catálogo de las zonas del parque. Es la lista que alimenta el campo `idSectorParque` al publicar una actividad (sección 16).

**No es un módulo de permiso aparte:** se gobierna con `ActividadesParque`, igual que los catálogos de la emisión de tickets viven bajo `EmisionTickets`. Quien puede publicar actividades puede crear los sectores que necesite.

| Endpoint | Permiso | Efecto |
|---|---|---|
| `POST /sectores` | `ActividadesParque` + `Crear` | Crear sector |
| `GET /sectores` | `ActividadesParque` + `Ver` | Listar, ordenados por nombre |
| `GET /sectores/:id` | `ActividadesParque` + `Ver` | Detalle |
| `PATCH /sectores/:id` | `ActividadesParque` + `Editar` | Renombrar |
| `PATCH /sectores/:id/activar` | `ActividadesParque` + `Editar` | Reactivar uno anulado |
| `DELETE /sectores/:id` | `ActividadesParque` + `Anular` | Baja lógica |

Reglas del módulo:

- **Nombre único**, de 3 a 255 caracteres. Se le recortan los espacios de los extremos antes de guardarlo.
- **El nombre repetido se rechaza con `409`, incluso si el sector existente está anulado.** En ese caso el mensaje indica que hay que reactivarlo: dos filas con el mismo nombre volverían indistinguibles las opciones del selector.
- **`DELETE` es baja lógica.** El sector desaparece del listado, pero **las actividades ya publicadas conservan el suyo**: anularlo lo retira del selector, no reescribe el historial.
- Un sector anulado **no se puede asignar** a una actividad nueva: `POST /actividades` devuelve `400`.

---

### 17.1 `POST /sectores` (Crear sector)
* **Permiso requerido:** `Módulo: 'ActividadesParque'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{ "nombre": "Sector Norte" }
```
* **Response (201 Created - JSON):**
```json
{
  "id": 1,
  "nombre": "Sector Norte",
  "fechaCreacion": "2026-08-18T02:34:00.000Z",
  "fechaActualizacion": "2026-08-18T02:34:00.000Z",
  "anulado": false
}
```
* **Errores:** `409` si el nombre ya existe; `400` si tiene menos de 3 caracteres.

---

### 17.2 `GET /sectores` (Listar) y `GET /sectores/:id` (Detalle)
* **Permiso requerido:** `Módulo: 'ActividadesParque'`, `Acción: 'Ver'`
* **Query Param (solo en el listado):** `incluirAnulados=true`
* **Response (200 OK - JSON):** Cada sector incluye cuántas actividades lo usan, para poder advertir antes de anularlo:
```json
[
  {
    "id": 1,
    "nombre": "Sector Norte",
    "fechaCreacion": "2026-08-18T02:34:00.000Z",
    "fechaActualizacion": "2026-08-18T02:34:00.000Z",
    "anulado": false,
    "_count": { "actividades": 3 }
  }
]
```
> El listado es un arreglo plano, sin paginación: es un catálogo corto que alimenta un selector.

`GET /sectores/:id` devuelve un solo objeto con la misma forma, o `404` si no existe.

---

### 17.3 `PATCH /sectores/:id` (Renombrar), `PATCH /sectores/:id/activar` y `DELETE /sectores/:id`
* **Permisos:** `Editar` para los dos `PATCH`, `Anular` para el `DELETE`.
* **Body de `PATCH /sectores/:id`:**
```json
{ "nombre": "Sector Norte alto" }
```
* **Response (200 OK - JSON):** El sector resultante.
* **Errores:**
  * `409` — el nombre pertenece a otro sector.
  * `400` — anular uno ya anulado, o activar uno que ya está activo.
  * `404` — el sector no existe.

Renombrar un sector se refleja de inmediato en todas las actividades que lo usan, porque se guarda la referencia y no una copia del nombre.


---

## 18. Venta offline (`/tickets/lotes-offline`, `/tickets/emitir-offline`)

Permite vender tickets **sin conexión a internet**, entregando al visitante un pase con QR **válido desde el momento de la venta**.

La idea es simple: el servidor entrega **folios pre-firmados** mientras hay red; el dispositivo los consume después, sin ella; al reconectar sube la cola y cada folio se convierte en un ticket real.

Diseño completo en `ESPECIFICACION_OFFLINE.md`.

### Conceptos

| Término | Qué es |
|---|---|
| **Folio reservado** | Un número de ticket con su firma HMAC, generado **antes** de que exista la venta |
| **Lote** | Un bloque de folios, atado a un usuario, un dispositivo y **la caja abierta al reservarlo** |

Estados del folio:

```
                    ┌─── conciliar ──────────> NO_UTILIZADO
RESERVADO ──────────┼─── invalidar el lote ──> INVALIDADO
                    └─── emitir-offline ─────> EMITIDO ──validar──> EMITIDO + fechaUso
```

> **Solo un folio `EMITIDO` autoriza el ingreso.** Un folio reservado tiene firma criptográficamente válida pero no corresponde a ninguna venta. Como vive en su propia tabla y no en `Ticket`, **`POST /tickets/validar` responde `404`** por él, idéntico a un folio inexistente — sin mensaje que revele que existe, para no confirmarle a nadie que el rango del bloque es real.

**Permisos:** todo se gobierna con `EmisionTickets`, igual que el resto de la emisión.

**Solo efectivo.** Sin conexión no hay pasarela, así que no hay cobro con tarjeta: cualquier otra forma de pago se rechaza al subir.

---

### 18.1 `POST /tickets/lotes-offline` (Reservar folios)
* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Crear'`
* **Request Body (JSON):**
```json
{ "cantidad": 100, "idDispositivo": "b3f1c2d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d" }
```

| Campo | Reglas |
|---|---|
| `cantidad` | Entero de 1 a 200 |
| `idDispositivo` | UUID persistente que genera el navegador; máximo 64 caracteres |

* **Exige caja abierta** (`400` si no hay). La caja **no la envía el cliente**: se toma la abierta actual.

* **Response (201 Created - JSON):**
```json
{
  "idLote": 7,
  "idAperturaCaja": 12,
  "idUsuario": 3,
  "idDispositivo": "b3f1c2d4-…",
  "estado": "ACTIVO",
  "fechaCreacion": "2026-08-20T13:00:00.000Z",
  "expiraEn": "2026-08-21T06:00:00.000Z",
  "expirado": false,
  "folios": [
    {
      "numeroTicket": "TCK-2026-000101",
      "firma": "9f2a7c…",
      "qr": "{\"numeroTicket\":\"TCK-2026-000101\",\"firma\":\"9f2a7c…\"}"
    }
  ]
}
```

> **El campo `qr` viene armado por el servidor**, en el mismo formato exacto que la emisión online. No lo reconstruya en el frontend: un cambio futuro de formato rompería los pases offline en silencio y el problema aparecería recién en la puerta de la cueva.

* **Errores:**

```json
{ "codigo": "LOTE_ACTIVO_EXISTENTE", "idLote": 7 }
```
`409` si ese dispositivo ya tiene un lote activo. Concílielo primero, o recupérelo con 18.2.

> **Pida lotes chicos, no el máximo por costumbre.** Cada folio que quede sin vender consume un número del correlativo y deja un hueco permanente en la numeración. Lotes chicos también limitan el daño si se pierde el dispositivo.
>
> **Los lotes vencidos de ese dispositivo se concilian solos al reservar el nuevo.** No hace falta conciliar el anterior antes de reemplazarlo: el frontend solo conoce su lote *actual*, y el viejo puede ni estar en el dispositivo (se reinstaló, se borró el almacenamiento, es otro aparato). Sus folios pasan a `NO_UTILIZADO` y queda registro en Bitácora.
>
> **Sincronice antes de que termine la jornada.** Una venta que no se haya subido cuando el lote vence ya no se puede subir: sus folios dejan de estar disponibles.

---

### 18.2 `GET /tickets/lotes-offline/activo` (Recuperar el lote)
* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Ver'`
* **Query Param:** `idDispositivo` (obligatorio)

Para cuando se reinstala la aplicación o se borra el almacenamiento local. Sin esto los folios quedan inutilizables hasta que expiren y el taquillero no puede vender.

* **Response (200 OK - JSON):**
```json
{ "hayLoteActivo": true, "lote": { "…": "misma forma que 18.1" } }
```
o `{ "hayLoteActivo": false, "lote": null }`.

Solo devuelve los folios que siguen en `RESERVADO`.

> **Exige que coincidan usuario y dispositivo.** Este endpoint vuelve a exponer folios pre-firmados; desde otra sesión responde `hayLoteActivo: false`, no los entrega.

---

### 18.3 `POST /tickets/emitir-offline` (Subir la cola de ventas)
* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Crear'`
* **Request Body (JSON):** hasta **50 ventas** por llamada.
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
      "cantidades": [{ "idTipoVisitante": 1, "cantidad": 2 }],
      "idOpcionPago": 1,
      "notas": "Grupo con reserva previa",
      "guia": { "modo": "nuevo", "nombre": "Pedro Ak'abal", "tieneCarnet": false }
    }
  ]
}
```

Todo lo que va después de `montoCobrado` es el payload de `POST /tickets/emitir` sin cambios.

| Campo | Notas |
|---|---|
| `idLocal` | **UUID de 36 caracteres**, generado por el dispositivo. Es la clave de idempotencia |
| `numeroTicket` | Folio reservado que el dispositivo ya imprimió |
| `numeroTicketGuia` | Segundo folio, solo si la venta lleva guía sin carnet |
| `fechaEmision` | ISO 8601. Momento real de la venta |
| `montoCobrado` | **Texto**, no número: evita perder centavos en el punto flotante de JSON |

> **No se acepta marcar el ingreso en la misma llamada.** No existe un campo tipo `fechaUsoOffline`: subir la venta y validar el pase son dos actos distintos, y el segundo sigue siendo `POST /tickets/validar`. Enviar cualquier campo no declarado devuelve **`400`** (`forbidNonWhitelisted`), no se ignora en silencio.

* **Response (200 OK - JSON):** éxito parcial. **Nunca un `4xx` para el lote completo** si al menos un ítem es válido — el resto corresponde a dinero que ya entró al cajón.
```json
{
  "procesadas": 2,
  "resultados": [
    { "idLocal": "f47ac10b-…", "estado": "CREADO", "discrepancia": null, "ticket": { "…": "TicketBackend" } },
    { "idLocal": "a91bd22c-…", "estado": "DUPLICADO_IGNORADO", "ticket": { "…": "…" } },
    { "idLocal": "c02ef88a-…", "estado": "RECHAZADO", "codigo": "FOLIO_YA_EMITIDO", "mensaje": "…" }
  ]
}
```

**Códigos de rechazo:**

| Código | Significa |
|---|---|
| `FOLIO_NO_RESERVADO` | El folio no existe, o ya no está disponible |
| `FOLIO_YA_EMITIDO` | **El dispositivo gastó dos veces el mismo folio**: hay una venta cobrada que se va a perder. Hay que investigarla |
| `FOLIO_DE_OTRO_LOTE` | El folio pertenece a otro lote |
| `LOTE_INVALIDADO` | El lote se invalidó; ninguna venta suya puede subirse |
| `PAGO_NO_EFECTIVO` | Offline solo se vende en efectivo |
| `CATALOGO_INVALIDO` | Datos de la venta inválidos (atracción, país, categoría…) |

> El resultado **por ítem** es lo que le permite al frontend distinguir *"no hubo red, reintento"* de *"el servidor lo rechazó, aviso al taquillero y no reintento"*. Sin esa distinción, la cola reintenta para siempre una venta que nunca va a entrar.

#### Reglas que aplica el servidor

1. **Idempotencia.** Un `idLocal` ya registrado devuelve `DUPLICADO_IGNORADO` sin crear nada. Es lo que permite reintentar tras un timeout ambiguo. *(Garantizado por un índice único; ver 18.7.)*
2. **La caja es la del lote**, no la que esté abierta al subir: la venta ocurrió en aquel turno y ahí tiene que cuadrar.
3. **La fecha del dispositivo se acota** al rango `[creación del lote, ahora]`. Viene del reloj del aparato y no es confiable; un reloj mal puesto mandaría la venta al arqueo de otro día.
4. **El precio se recalcula con la tarifa vigente en `fechaEmision`**, no con la de hoy. Una venta de ayer se recalcula con el precio de ayer.
5. **Un guía nuevo repetido se reutiliza.** Offline es normal que el mismo guía acompañe a varios grupos del turno: la primera venta lo crea y las demás lo reutilizan. *(La emisión online sigue rechazando nombres repetidos con `409`, porque ahí el taquillero puede corregir en el momento.)*
6. **Cada venta va en su propia transacción**: una con datos malos no aborta las otras 49.

#### Discrepancia de monto

Si lo cobrado difiere de lo recalculado, la venta **se registra igual**:

```json
"discrepancia": { "montoCobrado": "30", "montoRecalculado": "40", "diferencia": "-10" }
```

> **No se rechaza por discrepancia.** El visitante ya pagó y ya entró; rechazar dejaría dinero en la caja sin ticket que lo respalde, que es peor. El `TicketPago` se crea por **lo cobrado** —que es lo que hay en el cajón— y la diferencia queda en `Ticket.montoRecalculado` y en el arqueo (sección 8.5), visible solo para un supervisor.

---

### 18.4 `POST /tickets/lotes-offline/:id/conciliar` (Cerrar el lote)
* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Crear'`
* **Request Body (JSON, opcional):** el dispositivo declara lo que hizo, como contraste.
```json
{
  "foliosUtilizados": ["TCK-2026-000101", "TCK-2026-000102"],
  "foliosNoUtilizados": ["TCK-2026-000103"]
}
```
* **Response (200 OK - JSON):**
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

Todo folio que siga en `RESERVADO` pasa a `NO_UTILIZADO`, para que la auditoría no vea huecos inexplicados en la secuencia.

> **Un folio declarado vendido del que el servidor no tiene ticket sale como advertencia, no como error.** Significa una venta que se perdió (almacenamiento corrupto, cola borrada) y hay que investigarla, pero bloquear la conciliación dejaría la caja sin poder cerrarse.

* Falla con `400` si el lote ya estaba conciliado o invalidado. **Conciliar es requisito para cerrar la caja** (ver 8.6).

---

### 18.5 `DELETE /tickets/lotes-offline/:id` (Invalidar lote)
* **Permiso requerido:** `Módulo: 'EmisionTickets'`, `Acción: 'Anular'`
* **Response (200 OK - JSON):**
```json
{ "idLote": 7, "estado": "INVALIDADO", "foliosInvalidados": 88 }
```

Para dispositivo perdido o robado. Los folios en `RESERVADO` pasan a `INVALIDADO` y las subidas posteriores contra ese lote se rechazan. **Los folios ya emitidos no se tocan: esas ventas existen.**

> **Destruye las ventas offline que todavía no se hubieran subido.** Ese dinero quedaría cobrado sin ticket. Usar solo cuando el dispositivo no va a volver.

---

### 18.6 Un usuario dado de baja conserva el derecho a sincronizar

Si a un taquillero lo dan de baja **mientras su dispositivo está sin conexión**, sus ventas ya cobradas quedarían atrapadas: el guard lo rechazaría con `401` al reconectar, y la caja quedaría con dinero que ningún ticket respalda.

**Baja no es repudio de lo actuado.** Las ventas ocurrieron mientras la sesión era legítima; impedir que se registren no las deshace, solo las esconde.

**Qué puede hacer un usuario anulado:**

| Endpoint | Por qué |
|---|---|
| `POST /auth/refresh` | Sin token de acceso vigente no puede llamar a nada más |
| `POST /tickets/emitir-offline` | Es el acto de liquidar lo ya vendido |
| `POST /tickets/lotes-offline/:id/conciliar` | Cerrar el lote para que la caja pueda cerrarse |

Todo lo demás sigue devolviendo `401`. En particular **no** puede reservar folios nuevos ni recuperar folios pre-firmados: eso sería seguir operando, no liquidar.

**Cómo se hace cumplir:**

1. El derecho **está atado a que haya algo que liquidar**: solo se renueva la sesión si el usuario tiene un lote `ACTIVO` y sin vencer. Sin eso, la baja es total y `/auth/refresh` responde `401`.
2. El token de acceso que recibe viene marcado con **`soloSincronizacion: true`** y el guard lo **rechaza en cualquier otro handler**, incluso si el usuario volviera a estar activo. Sin esto, refrescar tras la baja devolvería acceso completo y la baja no serviría de nada.
3. Cada renovación queda en Bitácora como **`REFRESH_USUARIO_ANULADO`**, indicando qué lote la justifica.

La respuesta del refresh lo anuncia, para que el frontend pueda mostrar solo la pantalla de sincronización:

```json
{
  "access_token": "…",
  "refresh_token": "…",
  "solo_sincronizacion": true,
  "aviso": "Su usuario fue deshabilitado. Esta sesión solo permite subir y conciliar las ventas offline pendientes; el resto del sistema no está disponible."
}
```

---

### 18.7 Despliegue: dos índices que hay que crear a mano

**`prisma db push` no los crea.** Después de cada `db push`, ejecutar:

```bash
npx ts-node prisma/aplicar-indices-offline.ts
```

En SQL Server un índice único admite **una sola fila con `NULL`**, y las dos columnas son anulables por diseño (`Ticket.idLocal` es nulo en todas las ventas online; `FolioReservado.idTicket` lo es mientras el folio está reservado). Por eso son índices **filtrados**, que Prisma no sabe expresar en el esquema.

| Índice | Garantiza |
|---|---|
| `UX_Ticket_idLocal` | Reintentar la subida no duplica tickets |
| `UX_FolioReservado_idTicket` | Un folio no respalda dos ventas |

> **Perderlos no falla de forma visible.** Simplemente desaparece la garantía de idempotencia y los reintentos de la cola empiezan a duplicar tickets **en silencio**. El script es idempotente y verifica que los índices queden únicos *y* filtrados.

**Variable de entorno opcional:** `OFFLINE_EXPIRA_HORA` (hora a la que vence la jornada; por defecto `6`).

---

## 19. Reportes (`/reportes`)

> **Para integrar desde el frontend, empieza por [`REPORTES_FRONTEND.md`](./REPORTES_FRONTEND.md)**:
> trae el componente de tabla genérico, cómo descargar los archivos protegidos y un
> checklist de integración. Esta sección es la especificación del contrato.

Reportes del sistema en **dos vías**, y conviene tener clara la diferencia antes de integrar:

| | Vía predeterminada | Vía a medida |
|---|---|---|
| Ruta | `GET /reportes/:clave` (+ `/pdf`, `/excel`) | `POST /reportes/interpretar` |
| Qué hace | Ejecuta uno de los **18 reportes del catálogo** | Traduce una frase en español a uno de esos mismos 18 reportes |
| ¿Llama a un servicio externo? | **No, nunca** | Sí, una vez, solo para elegir el reporte y los filtros |
| ¿Consume cuota? | No | Sí |
| Si el proveedor de IA cae | Sigue funcionando | `503` |

**Las cifras las produce siempre el mismo código.** La IA no consulta la base, no escribe SQL y
no redacta ningún número: devuelve una clave de una lista cerrada y unos filtros en texto, que
el servidor valida y resuelve contra su propia base. Un reporte pedido por frase y el mismo
pedido con botones dan exactamente el mismo resultado.

Los botones del frontend deben pegar a la **vía predeterminada**. La vía a medida es para cuando
alguien necesita algo que no está en el catálogo.

### 19.1 `GET /reportes` (Catálogo)

* **Permiso requerido:** `Módulo: 'Reportes'`, `Acción: 'Ver'`

Devuelve **solo los reportes que ese usuario puede ejecutar**: el catálogo se filtra por el
permiso del módulo dueño de los datos de cada reporte (ver 19.6). Alimenta el menú y los
formularios de filtro del frontend.

* **Response (200 OK - JSON):**
```json
{
  "datos": [
    {
      "clave": "ventas-por-vendedor",
      "titulo": "Ventas por vendedor",
      "descripcion": "Cuánto vendió cada cajero o vendedor en el período...",
      "categoria": "Tickets",
      "moduloOrigen": "EmisionTickets",
      "soloSupervisor": false,
      "orientacion": "vertical",
      "filtros": [
        {
          "clave": "periodo",
          "etiqueta": "Período",
          "tipo": "rangoFechas",
          "descripcion": "Rango de fechas del reporte, ambas inclusive...",
          "requerido": true,
          "parametros": ["desde", "hasta"]
        },
        {
          "clave": "vendedor",
          "etiqueta": "Vendedor",
          "tipo": "usuario",
          "descripcion": "...",
          "parametros": ["vendedor"]
        }
      ],
      "formatos": ["json", "pdf", "excel"]
    }
  ],
  "total": 18,
  "interpretacionDisponible": true
}
```

`interpretacionDisponible` es `false` cuando no hay `IA_API_KEY` configurada: con ese valor el
frontend no debe pintar el campo de petición en lenguaje natural.

> **`clave` frente a `parametros`.** `clave` identifica el control que pinta el frontend;
> `parametros` son los nombres reales de la query string. Casi siempre coinciden, pero el
> rango de fechas es **un** control y **dos** parámetros (`desde` y `hasta`): un formulario
> genérico que use `clave` mandaría `periodo=...` y se llevaría un `400`. Úsese siempre
> `parametros` para armar la URL.

---

### 19.2 Catálogo de reportes

| Clave | Categoría | Módulo de permiso | Qué responde |
|---|---|---|---|
| `ventas-resumen` | Tickets | `EmisionTickets` | Recaudado, tickets, personas y ticket promedio del período, con una fila por día |
| `ventas-por-vendedor` | Tickets | `EmisionTickets` | Cuánto vendió cada cajero y qué porcentaje del total representa |
| `ventas-por-atraccion` | Tickets | `EmisionTickets` | Cuevas vs. mariposario, con segunda sección por tipo de recorrido |
| `ventas-por-tipo-visitante` | Tickets | `EmisionTickets` | Adultos, niños, niños menores y centros educativos: personas y subtotal |
| `ventas-por-origen` | Tickets | `EmisionTickets` | Nacional vs. extranjero, con segunda sección por país |
| `ventas-por-forma-pago` | Tickets | `EmisionTickets` | Efectivo vs. tarjeta, separando `PAGADO` / `PENDIENTE` / `CANCELADO` |
| `ventas-detalle` | Tickets | `EmisionTickets` | El libro de ventas: un renglón por ticket |
| `tickets-anulados` | Tickets | `EmisionTickets` | Qué se anuló, cuándo, por cuánto y quién lo emitió |
| `cajas-turnos` | Cajas | `Cajas` | Turnos del período con apertura, cierre, inicial y contado (+ arqueo si supervisa) |
| `arqueo-de-caja` | Cajas | `Cajas` | Arqueo detallado de un turno. **Solo supervisor**; exige el filtro `caja` |
| `donaciones-resumen` | Donaciones | `Donaciones` | Recaudado en donaciones por día y por usuario que las recibió |
| `donaciones-detalle` | Donaciones | `Donaciones` | Listado de recibos, con los anulados marcados y sin monto |
| `bitacora-detalle` | Bitácora | `Bitacora` | Registro cronológico de acciones: fecha, usuario, módulo, acción y descripción |
| `bitacora-resumen` | Bitácora | `Bitacora` | Conteo de acciones por módulo, por usuario y por tipo de acción |
| `usuarios-listado` | Usuarios | `Usuarios` | Padrón con puesto, estado, fecha de alta y último acceso |
| `usuarios-permisos` | Usuarios | `Usuarios` | Matriz de permisos: una fila por usuario, una columna por módulo |
| `actividades-listado` | Actividades | `ActividadesParque` | Actividades del período con sector, responsable y estado |
| `actividades-por-sector` | Actividades | `ActividadesParque` | Conteo por sector y por responsable |

---

### 19.3 `GET /reportes/:clave` (Ejecutar en JSON)

* **Permiso requerido:** `Módulo: 'Reportes'`, `Acción: 'Ver'` **más** `Ver` sobre el módulo de origen (19.6)
* **Query Params:** los que declare el reporte en su `filtros`. Todos opcionales salvo donde se
  indique. Un parámetro no declarado devuelve `400`.

| Parámetro | Acepta | Notas |
|---|---|---|
| `desde` / `hasta` | `AAAA-MM-DD` | Ambas inclusive. Si se omiten, se usa el mes en curso. Máximo 366 días |
| `vendedor`, `atraccion`, `origen`, `pais`, `guia`, `tipoVisitante`, `tipoRecorrido`, `formaPago`, `sector` | **id o nombre** | El frontend manda ids porque ya tiene los catálogos; también acepta el nombre y lo resuelve |
| `caja` | id de la apertura | Obligatorio en `arqueo-de-caja` |
| `modulo`, `accion` | texto | Solo en los reportes de bitácora; coincidencia parcial |
| `incluirAnulados` | `true` / `false` | Solo donde el reporte lo declara |

* **Response (200 OK - JSON):**
```json
{
  "clave": "ventas-por-vendedor",
  "titulo": "Ventas por vendedor",
  "subtitulo": null,
  "periodo": { "desde": "2026-08-01", "hasta": "2026-08-31", "etiqueta": "1 al 31 de agosto de 2026" },
  "filtrosAplicados": [{ "etiqueta": "Atracción", "valor": "Cuevas Actun Kan" }],
  "kpis": [
    { "etiqueta": "Recaudado", "valor": "Q315.00" },
    { "etiqueta": "Tickets emitidos", "valor": "13" }
  ],
  "secciones": [
    {
      "titulo": null,
      "columnas": [
        { "clave": "grupo", "titulo": "Vendedor", "formato": "texto", "ancho": 0.32 },
        { "clave": "tickets", "titulo": "Tickets", "formato": "entero", "total": "suma" },
        { "clave": "total", "titulo": "Total", "formato": "moneda", "total": "suma" },
        { "clave": "participacion", "titulo": "% del total", "formato": "porcentaje" }
      ],
      "filas": [
        { "grupo": "Giselle Pereira", "tickets": 11, "personas": 11, "total": "215.0000", "participacion": "0.682540" }
      ],
      "totales": { "tickets": "13", "personas": "16", "total": "315.0000" },
      "filasDisponibles": 2
    }
  ],
  "orientacion": "vertical",
  "notas": ["Los tickets anulados nunca suman al recaudado..."],
  "generadoEn": "2026-09-05T09:48:00.000Z",
  "generadoPor": "Romeo Santos",
  "truncado": false
}
```

**Cómo pintarlo.** La estructura es genérica a propósito: `columnas` dice cómo formatear cada
celda y el frontend no necesita conocer ningún reporte en concreto.

| `formato` | Cómo se muestra |
|---|---|
| `moneda` | `Q` + separador de miles + 2 decimales |
| `entero` | Separador de miles, sin decimales |
| `decimal` | Separador de miles, `decimales` decimales (2 por defecto) |
| `porcentaje` | El valor es una **fracción** (`0.6825`); se multiplica por 100 al mostrar |
| `fecha` | `AAAA-MM-DD` |
| `fechaHora` | `AAAA-MM-DD HH:MM` |
| `texto` | Tal cual |

* Los importes viajan como **cadena decimal**, no como número: parsearlos con `Number` antes de
  sumar reintroduce el error de coma flotante. Para mostrar basta con formatear.
* `alineacion` es opcional; por omisión los formatos numéricos van a la derecha.
* Una celda `null` significa sin dato y conviene mostrarla como `—`, no en blanco: una celda
  vacía se confunde con un cero perdido.
* Un reporte puede traer **varias secciones**, cada una con sus propias columnas.
* `truncado: true` significa que se alcanzó el tope de filas; el motivo va en la primera nota.

* **Errores:**
  * `400` — fecha mal formada, rango invertido, rango de más de 366 días, o parámetro no declarado.
  * `403` — falta el permiso del módulo de origen, o el reporte es solo de supervisor.
  * `404` — la clave no existe; el mensaje lista las válidas.
  * `422` — un filtro por nombre no se pudo resolver, o coincide con varias opciones (el mensaje trae los candidatos).

---

### 19.4 `GET /reportes/:clave/pdf` y `GET /reportes/:clave/excel`

* **Permiso requerido:** `Módulo: 'Reportes'`, `Acción: 'Exportar'` **más** `Ver` sobre el módulo de origen
* **Query Params:** idénticos a 19.3

Mismos datos, otro envoltorio. El selector PDF/Excel del frontend es elegir a cuál de las dos
URL navegar; el resto de la query string no cambia.

| | PDF | Excel |
|---|---|---|
| `Content-Type` | `application/pdf` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `Content-Disposition` | `inline` | `attachment` |
| Tope de filas | 5 000 | 50 000 |
| Para qué sirve | Imprimir, archivar, firmar | Filtrar, sumar, tablas dinámicas |

* **PDF:** tamaño carta, con los logos, el período, la línea de filtros aplicados, tarjetas de
  indicadores, una tabla por sección con el encabezado repetido en cada página, fila de totales y
  pie con «Página X de Y». La orientación la decide el reporte según lo que necesiten sus columnas.
* **Excel:** una hoja `Resumen` con los indicadores y las notas, más una hoja por sección. **Los
  números se escriben como números**, con su formato: al seleccionar una columna de montos, Excel
  muestra la suma. Cada hoja lleva autofiltro, encabezados congelados y una fila de totales con
  `SUBTOTAL`, que se recalcula al filtrar dentro de la hoja.

> El xlsx va como `attachment` y no `inline` a propósito: ningún navegador lo renderiza, y en
> línea solo consigue abrirse como basura binaria en una pestaña.

---

### 19.5 `POST /reportes/interpretar` (Reporte a medida)

* **Permiso requerido:** `Módulo: 'Reportes'`, `Acción: 'Ver'`
* **Límite:** 15 peticiones por minuto (más estricto que el global: la cuota gratuita del
  proveedor es el recurso escaso)
* **Request Body (JSON):**
```json
{ "instruccion": "ventas del vendedor Juan en las cuevas en agosto, desglosadas por día" }
```

La instrucción es texto libre, de 5 a 500 caracteres.

* **Response (200 OK - JSON):**
```json
{
  "instruccion": "ventas del vendedor Juan en las cuevas en agosto, desglosadas por día",
  "interpretacion": "Ventas de Juan Pérez en Cuevas Actun Kan, del 1 al 31 de agosto de 2026, por día.",
  "especificacion": {
    "clave": "ventas-resumen",
    "filtros": { "desde": "2026-08-01", "hasta": "2026-08-31", "vendedor": "Juan", "atraccion": "cuevas" }
  },
  "formato": "pdf",
  "urlDescarga": "/reportes/ventas-resumen/pdf?desde=2026-08-01&hasta=2026-08-31&vendedor=4&atraccion=1",
  "resultado": { "...": "el mismo objeto de 19.3" }
}
```

**Cómo integrarlo:**

1. Mostrar `interpretacion` para que el usuario confirme que se le entendió.
2. Pintar `resultado` con el mismo componente de tabla de 19.3.
3. Resaltar el botón del formato que indica `formato` (`pdf` salvo que la frase pidiera Excel
   de forma explícita) y **descargar contra `urlDescarga`**, que ya es una URL de la vía 1.

> **La descarga no cuesta otra llamada a la IA**, ni la primera vez ni al cambiar de PDF a Excel:
> `urlDescarga` apunta a la vía predeterminada, con los ids ya resueltos. Guardarla como favorito
> convierte una petición en lenguaje natural en un botón permanente y gratuito.

* **Errores:**
  * `400` — instrucción vacía, demasiado corta o de más de 500 caracteres.
  * `422` — no se pudo interpretar tras dos intentos (el mensaje lista los reportes disponibles),
    o un nombre del filtro es ambiguo.
  * `503` — no hay `IA_API_KEY` configurada, el proveedor no responde, o se agotó la cuota diaria.
    **Los 18 reportes predeterminados siguen funcionando.**

**Qué sale del servidor hacia el proveedor:** la frase que escribió el usuario, la descripción
estructural del catálogo (claves, descripciones y nombres de filtro) y la fecha de hoy. **Nada
más.** Ni un nombre de empleado, ni un catálogo con datos, ni una cifra: los nombres propios los
resuelve el backend contra su propia base después de recibir la respuesta.

---

### 19.6 Permisos: tres capas, no una

`Reportes.Ver` abre el módulo, **no los datos**.

1. **Ruta** — `Reportes.Ver` para consultar y `Reportes.Exportar` para descargar.
2. **Reporte** — además hace falta `Ver` sobre el módulo dueño de las cifras (columna «Módulo de
   permiso» en 19.2). Sin esta capa, dar acceso a reportes entregaría de golpe la bitácora, la
   matriz de permisos y las donaciones a quien solo debía ver tickets. `GET /reportes` ya filtra
   el catálogo por lo mismo, así que cada quien solo ve lo que puede ejecutar.
3. **Columna** — las cifras del arqueo (`montoEsperado`, `diferencia`) exigen `Cajas.Editar`, la
   misma acción que representa supervisión en `/cajas`.

> **Las columnas de supervisión se borran del dato, no del dibujo.** No es un detalle de
> presentación: quien cuenta el efectivo no debe conocer el monto esperado, porque bastaría
> teclear esa cifra para que ningún faltante saliera a la luz. Si solo se ocultaran al dibujar,
> el valor seguiría viajando en el JSON y dentro del `.xlsx`, y el control de `/cajas` quedaría
> anulado por la puerta de atrás. Un cajero que pide `cajas-turnos` recibe la tabla sin esas
> columnas y sin esas claves en las filas.

`arqueo-de-caja` es supervisor de principio a fin: no basta con quitarle columnas, porque el
desglose completo permitiría deducir la cifra.

**Toda generación queda en bitácora** (`modulo: 'Reportes'`), con `GENERAR_REPORTE` para las
consultas y `EXPORTAR_REPORTE` para las descargas, indicando la clave y el período. Un módulo que
expone dinero, nombres y permisos tiene que dejar rastro de quién consultó qué.

---

### 19.7 Reglas de negocio que respetan todos los reportes

* **Los anulados nunca suman dinero.** Un ticket anulado no cobró nada ni dio acceso, y ya salió
  del arqueo de su caja. Se cuentan y se muestran por separado.
* **El dinero viaja como cadena decimal.** Nunca pasa por coma flotante dentro del servidor.
* **El día es el de Guatemala (UTC-6).** «Del 1 al 31 de agosto» incluye el 31 completo. Las
  ventas se imputan por su fecha de registro en el servidor, igual que `GET /tickets` y el arqueo:
  una venta offline subida a la mañana siguiente cuenta en el día en que se subió.
* **Rango máximo de 366 días**, para que una consulta no bloquee el pool de conexiones.

---

### 19.8 Despliegue

```bash
# 1. Módulo de permisos (aditivo e idempotente)
npx ts-node prisma/seed-reportes.ts

# 2. Índices de cobertura que Prisma no sabe declarar (INCLUDE)
npx prisma db push
npx ts-node prisma/aplicar-indices-reportes.ts

# 3. Asignar los permisos a cada usuario
#    POST /usuarios/:id/permisos  -> Reportes.Ver y Reportes.Exportar
```

Igual que los índices de la venta offline (18.7), los de reportes hay que **volver a aplicarlos
después de cada `db push`**: Prisma no recrea lo que no conoce. Perderlos no cambia ninguna cifra
—los reportes siguen siendo correctos— pero cada uno pasa de resolverse con el índice a recorrer
la tabla entera.

El esquema también incorpora índices nuevos que sí son declarables y llegan con la migración:
`Bitacora` no tenía **ninguno** y ahora soporta dos reportes; `TicketPago.idTicket` tampoco, y
SQL Server no indexa las claves foráneas por su cuenta.

**Variables de entorno nuevas (opcionales):** `IA_BASE_URL`, `IA_API_KEY`, `IA_MODELO`. Solo las
usa 19.5. Para cambiar de proveedor basta con editarlas: cualquiera que hable el contrato de
OpenAI sirve (Gemini por defecto; Groq con `IA_BASE_URL=https://api.groq.com/openai/v1`).
