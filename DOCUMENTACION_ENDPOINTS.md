# Documentación de Endpoints y Estructuras JSON

Documento de referencia para la integración con la API REST del sistema **Aktun Kan Backend**. Contiene los métodos HTTP, rutas, parámetros, estructuras del cuerpo de solicitud (`Request Body`) y respuestas esperadas (`Response Body`) en formato JSON para las operaciones de **POST**, **GET**, **PATCH/UPDATE**, **ACTIVAR**, **RESTABLECER CONTRASEÑA** y **DELETE/ANULAR**.

---

## Novedades en Autenticación
- **Restablecimiento de Contraseña con Código de 6 Dígitos:** Se agregaron los endpoints públicos `POST /auth/solicitar-codigo-restablecimiento`, `POST /auth/validar-codigo-restablecimiento` y `POST /auth/restablecer-contrasena` con envío de correos vía Nodemailer.
- **Activación de Registros:** Endpoints explícitos `PATCH /:id/activar` para reactivar registros anulados en **Usuarios**, **Puestos** y **Módulos**.
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
| `SMTP_*` | Sí para correos | Configuración de Nodemailer |

## Estructura de permisos

El sistema se organiza en **módulos generales**, que pueden agrupar **sub-módulos** con permisos propios (`Modulo.idModuloPadre`). El permiso siempre se evalúa como **módulo + acción**.

| Módulo general | Sub-módulos | Cubre |
|---|---|---|
| `EmisionTickets` | — | Todo lo relacionado a tickets: emisión, historial, validación de QR, tarifas y la lectura de catálogos (atracciones, guías, países, tipos, formas de pago) |
| `Cajas` | `Gastos` | Apertura, cierre y arqueo. `Gastos` es sub-módulo con permisos propios (incluye el catálogo de tipos de gasto) |
| `Usuarios` | `Puestos` | Usuarios, puestos y todo el catálogo de permisos (`/modulos`, `/acciones`, `/modulo-acciones`) |
| `Bitacora` | — | Consulta de bitácora |

> **Emisión de Tickets es un módulo general**: atracciones, guías, tarifas y demás catálogos **no** son módulos de permiso aparte. Quien tiene permiso sobre `EmisionTickets` lo tiene sobre todo el módulo, con la granularidad de las 4 acciones.

### Administración del catálogo de permisos

Las rutas `/modulos`, `/acciones` y `/modulo-acciones` **exigen permiso sobre `Usuarios`**, porque administrar el catálogo de permisos es parte de administrar usuarios. Ya no existen filas `Modulos` ni `Acciones` en la tabla `Modulo`: eran módulos que se protegían a sí mismos y solo generaban confusión al asignar permisos.

- `GET /modulo-acciones` devuelve **solo los vínculos asignables** (módulos activos y no de infraestructura); es lo que debe alimentar la pantalla de asignación. Con `?incluirNoAsignables=true` se ve todo.
- `GET /modulos?soloAsignables=true` filtra por el campo `esAsignable`, disponible para cualquier módulo interno que se agregue en el futuro.
- `POST /usuarios/:id/permisos` **rechaza con `400`** los vínculos de módulos no asignables o anulados, indicando qué IDs se rechazaron.

El menú **no** depende de ningún permiso: usa `GET /modulos/mis-modulos` (ver 4.7), que solo exige sesión válida. Así, cambiar la asignación de permisos nunca deja a un usuario sin navegación.

Pendientes de implementar (aún sin código): `Donaciones`, `Sincronizacion`, `Reportes`, `ActividadesParque`.

- **Acciones:** `'Ver'`, `'Crear'`, `'Editar'`, `'Anular'`, `'Exportar'`
- Un handler **sin** `@RequirePermission` queda accesible a cualquier usuario autenticado (`permissions.guard.ts` es fail-open por diseño), así que toda ruta nueva debe declararlo explícitamente.

## Novedades en Cajas
- **Apertura y cierre de caja con arqueo automático:** Se agregó el módulo `/cajas`. Al cerrar, el sistema calcula el monto esperado (`montoInicial + ventas en efectivo - gastos`) y lo compara contra el monto contado, generando una `diferencia` (sobrante/faltante).
- **Inmutabilidad:** Ni la apertura ni el cierre se editan una vez creados — solo se pueden **anular** (`Cajas` / `Anular`). El módulo `Cajas` no usa la acción `'Editar'`.
- **Gastos:** Se agregó `/gastos` (registro de gastos contra la caja abierta actual) y su catálogo `/tipos-gasto`.
- **Integridad del arqueo:** un gasto solo puede crearse, editarse o anularse mientras su caja sigue **abierta**. Tocarlo después del cierre devuelve `400`, porque alteraría de forma retroactiva un arqueo ya guardado.
- **Reapertura controlada:** anular un cierre devuelve `409` si en ese momento hay otra caja abierta; nunca pueden quedar dos cajas abiertas a la vez.
- **Trazabilidad:** cada gasto guarda `idUsuario` (quién lo registró), además del registro en Bitácora.
- **Configuración requerida tras desplegar:** ejecutar `npx ts-node prisma/seed-modulos-dinero.ts` para registrar el módulo general `'Cajas'` y su sub-módulo `'Gastos'` con sus acciones (script aditivo e idempotente). Después, otorgar los permisos a cada usuario con `POST /usuarios/:id/permisos`.

## Novedades en Tickets
- **Módulo de emisión completo:** `/tickets` (catálogos, emisión, historial con métricas y validación de QR en taquilla) y `/tarifas` con vigencia histórica.
- **Sin CRUD por catálogo:** atracciones, orígenes, países, tipos y formas de pago son datos de configuración que alimentan el formulario. Se leen todos con `GET /tickets/catalogos` y se administran por seed.
- **Cierra el circuito de dinero:** cada ticket queda asociado a la caja abierta y genera su `TicketPago`; el arqueo de `/cajas/:id/arqueo` por fin suma ventas en efectivo además de restar gastos.
- **Variables de entorno nuevas:** `TICKET_QR_SECRET` (firma HMAC del QR — si cambia, los pases ya impresos dejan de validar) y `TICKET_SERIE` (serie alfanumérica del folio, default `TCK`).
- **Permiso único:** todo el módulo se controla con `EmisionTickets` + acción. Los catálogos (atracciones, guías, tarifas, países…) **no** tienen módulo de permiso propio.
- **Seed:** `npx ts-node prisma/seed-tickets.ts` siembra catálogos y tarifas iniciales; `npx ts-node prisma/reorganizar-modulos.ts` consolida la estructura de módulos generales y sub-módulos.

---

## Índice de Contenidos
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
* **Query Params (Opcional):** `?incluirAnulados=true`
* **Response (200 OK - JSON):**
```json
[
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
]
```

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
* **Permiso requerido:** `Módulo: 'Usuarios'`, `Acción: 'Ver'`
* **Response (200 OK - JSON):**
```json
[
  {
    "id": 12,
    "idModulo": 1,
    "idAccion": 4,
    "modulo": { "id": 1, "nombre": "Usuarios", "anulado": false },
    "accion": { "id": 4, "nombre": "Anular" }
  }
]
```

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
  - `modulo` (texto): Filtrar por módulo (ej. `Auth`, `Usuarios`, `Puestos`, `Modulos`, `Acciones`).
  - `accion` (texto): Filtrar por tipo de acción (ej. `INICIO_SESION`, `CREAR_USUARIO`, `EDITAR_PUESTO`, `ANULAR_MODULO`, `ASIGNAR_PERMISOS`).
  - `fechaInicio` (ISO Date string): Filtrar desde fecha.
  - `fechaFin` (ISO Date string): Filtrar hasta fecha.
  - `limite` (número, defecto `100`): Cantidad máxima de registros a retornar.

* **Response (200 OK - JSON):**
```json
[
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
]
```

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
* **Query Params (Opcionales):** `?estado=Abierta`, `?fechaInicio=`, `?fechaFin=`, `?incluirAnulados=true`
* **Response (200 OK - JSON):** Arreglo de objetos con la misma forma que 8.1.

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

* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Ver'`
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "idApertura": 5,
  "montoInicial": 500,
  "ventasEfectivo": 1250,
  "totalGastos": 150,
  "montoEsperado": 1600
}
```

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
  }
}
```

---

### 8.7 `PATCH /cajas/:id/cierre/anular` (Anular Cierre y Reabrir Caja)
Anula el cierre vigente y revierte el estado de la caja a `'Abierta'`, para corregir un cierre hecho por error.

* **Permiso requerido:** `Módulo: 'Cajas'`, `Acción: 'Anular'`
* **Path Params:** `id` (número entero, ID de la apertura)
* **Response (200 OK - JSON):** Falla con `400 Bad Request` si la caja no tiene un cierre vigente, y con `409 Conflict` si ya existe otra caja abierta (reabrir dejaría dos cajas abiertas).
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
* **Query Params (todos opcionales):** `buscar` (nombre, folio o guía), `idAtraccion`, `idOpcionPago`, `idOrigen`, `idPais`, `fechaInicio`, `fechaFin`, `incluirAnulados=true`, `pagina` (default 1), `limite` (default 50, máx. 200)
* **Response (200 OK - JSON):** Las métricas se calculan en el servidor sobre el filtro aplicado, no solo sobre la página.
```json
{
  "datos": [ /* tickets con la misma forma que 11.1 */ ],
  "total": 128,
  "pagina": 1,
  "limite": 50,
  "metricas": {
    "totalTickets": 128,
    "totalPersonas": 412,
    "montoRecaudado": "8450.0000"
  }
}
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

## 12. Tarifas (`/tarifas`)

Editar un precio **no sobrescribe** la fila: cierra la vigencia de la tarifa actual y crea una nueva. Los tickets ya vendidos conservan el precio con el que se emitieron (`VisitantePorTicket.precioUnitario`).

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/tarifas` | `EmisionTickets` / `Ver` | Tarifas vigentes (atracción + origen + categoría) |
| GET | `/tarifas/historico` | `EmisionTickets` / `Ver` | Historial completo. Filtros: `idAtraccion`, `idOrigen` |
| GET | `/tarifas/guia` | `EmisionTickets` / `Ver` | Tarifa vigente del ticket de guía sin carnet |
| PATCH | `/tarifas` | `EmisionTickets` / `Editar` | `{ idAtraccion, idOrigen, idTipoVisitante, precio }` |
| PATCH | `/tarifas/guia` | `EmisionTickets` / `Editar` | `{ precio }` |

Validación: se rechaza precio ≤ 0 salvo en la categoría `nino_menor`, la única que admite Q0.

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
- Los **guías nuevos se crean dentro de `POST /tickets/emitir`** (bloque `guia.modo: "nuevo"`), no por un endpoint aparte.
- Para **editar precios** sí hay endpoints: ver sección 12 (`/tarifas`).
- `/tipos-gasto` sigue existiendo aparte porque pertenece al sub-módulo `Gastos` de `Cajas`, no a la emisión de tickets.

