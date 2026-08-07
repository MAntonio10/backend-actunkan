# Documentación de Endpoints y Estructuras JSON

Documento de referencia para la integración con la API REST del sistema **Aktun Kan Backend**. Contiene los métodos HTTP, rutas, parámetros, estructuras del cuerpo de solicitud (`Request Body`) y respuestas esperadas (`Response Body`) en formato JSON para las operaciones de **POST**, **GET**, **PATCH/UPDATE**, **ACTIVAR**, **RESTABLECER CONTRASEÑA** y **DELETE/ANULAR**.

---

## Novedades en Autenticación
- **Restablecimiento de Contraseña con Código de 6 Dígitos:** Se agregaron los endpoints públicos `POST /auth/solicitar-codigo-restablecimiento`, `POST /auth/validar-codigo-restablecimiento` y `POST /auth/restablecer-contrasena` con envío de correos vía Nodemailer.
- **Activación de Registros:** Endpoints explícitos `PATCH /:id/activar` para reactivar registros anulados en **Usuarios**, **Puestos** y **Módulos**.
- **Permisos requeridos (Inicial Mayúscula):**
  - **Módulos:** `'Usuarios'`, `'Puestos'`, `'Modulos'`, `'Acciones'`
  - **Acciones:** `'Ver'`, `'Crear'`, `'Editar'`, `'Anular'`, `'Exportar'`

---

## Índice de Contenidos
1. [Autenticación (`/auth`)](#1-autenticación-auth)
2. [Usuarios (`/usuarios`)](#2-usuarios-usuarios)
3. [Puestos (`/puestos`)](#3-puestos-puestos)
4. [Módulos (`/modulos`)](#4-módulos-modulos)
5. [Acciones (`/acciones`)](#5-acciones-acciones)
6. [Módulo-Acciones (`/modulo-acciones`)](#6-módulo-acciones-modulo-acciones)

---

## 1. Autenticación (`/auth`)

### 1.1 `POST /auth/login`
Inicia sesión en la plataforma y retorna un Token JWT de acceso.

* **Headers:** `Content-Type: application/json`
* **Request Body (JSON):**
```json
{
  "correo": "admin@aktunkan.com",
  "contrasena": "Password123!",
  "recordarme": true
}
```
> **Nota de Duración del Token:** 
> - Si `"recordarme": true` (Mantener sesión activa), el token JWT tendrá una validez de **1 año (`365d`)**.
> - Si `"recordarme": false` o se omite, el token tendrá la validez estándar de **24 horas (`24h`)**.

* **Response (201 Created - JSON):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Crear'`
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Ver'`
* **Query Params (Opcional):** `?incluirAnulados=true`
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Ver'`
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Editar'`
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

* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Editar'`
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Anular'`
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

## 5. Acciones (`/acciones`)

### 5.1 `POST /acciones` (Crear Acción)
* **Permiso requerido:** `Módulo: 'Acciones'`, `Acción: 'Crear'`
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
* **Permiso requerido:** `Módulo: 'Acciones'`, `Acción: 'Ver'`
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
* **Permiso requerido:** `Módulo: 'Acciones'`, `Acción: 'Ver'`
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
* **Permiso requerido:** `Módulo: 'Acciones'`, `Acción: 'Editar'`
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
* **Permiso requerido:** `Módulo: 'Acciones'`, `Acción: 'Anular'`
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Editar'`
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Ver'`
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Ver'`
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Ver'`
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
* **Permiso requerido:** `Módulo: 'Modulos'`, `Acción: 'Anular'`
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

* **Permiso requerido:** `Módulo: 'Auditoria'`, `Acción: 'Ver'`
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
* **Permiso requerido:** `Módulo: 'Auditoria'`, `Acción: 'Ver'`
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

