# Documentación de Endpoints y Estructuras JSON

Documento de referencia para la integración con la API REST del sistema **Aktun Kan Backend**. Contiene los métodos HTTP, rutas, parámetros, estructuras del cuerpo de solicitud (`Request Body`) y respuestas esperadas (`Response Body`) en formato JSON para las operaciones de **POST**, **GET**, **PATCH/UPDATE** y **DELETE/ANULAR**.

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
  "contrasena": "Password123!"
}
```

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

## 2. Usuarios (`/usuarios`)

### 2.1 `POST /usuarios` (Crear Usuario)
Registra un nuevo usuario en la base de datos bajo transacción atómica.

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
Obtiene el listado de usuarios registrados.

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
Actualiza parcialmente los datos de un usuario dentro de una transacción atómica.

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

### 2.5 `DELETE /usuarios/:id` (Anular Usuario)
Deshabilita/anula un usuario cambiando el estado `anulado: true` y actualizando la fecha en horario UTC-6 dentro de una transacción.

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

### 2.6 `POST /usuarios/:id/permisos` (Asignar Permisos a Usuario)
Reemplaza los permisos asignados a un usuario mediante transacción atómica.

* **Path Params:** `id` (ID del usuario)
* **Request Body (JSON):**
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
        "modulo": { "id": 1, "nombre": "puestos", "anulado": false },
        "accion": { "id": 1, "nombre": "ver" }
      }
    }
  ]
}
```

---

## 3. Puestos (`/puestos`)

### 3.1 `POST /puestos` (Crear Puesto)
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
  },
  {
    "id": 3,
    "nombre": "Guía de Recorrido",
    "descripcion": "Encargado de guiados dentro del parque",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:03:35.000Z",
    "fechaActualizacion": "2026-07-24T14:03:35.000Z"
  }
]
```

---

### 3.3 `GET /puestos/:id` (Obtener Puesto por ID)
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

### 3.5 `DELETE /puestos/:id` (Anular Puesto)
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
* **Request Body (JSON):**
```json
{
  "nombre": "tickets"
}
```

* **Response (201 Created - JSON):**
```json
{
  "id": 4,
  "nombre": "tickets",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:03:35.000Z"
}
```

---

### 4.2 `GET /modulos` (Listar Módulos)
* **Query Params (Opcional):** `?incluirAnulados=true`
* **Response (200 OK - JSON):**
```json
[
  {
    "id": 1,
    "nombre": "usuarios",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z",
    "moduloAcciones": [
      {
        "id": 1,
        "idModulo": 1,
        "idAccion": 1,
        "accion": { "id": 1, "nombre": "ver" }
      }
    ]
  }
]
```

---

### 4.3 `GET /modulos/:id` (Obtener Módulo por ID)
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 4,
  "nombre": "tickets",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:03:35.000Z",
  "moduloAcciones": []
}
```

---

### 4.4 `PATCH /modulos/:id` (Actualizar Módulo)
* **Path Params:** `id` (número entero)
* **Request Body (JSON):**
```json
{
  "nombre": "venta-tickets"
}
```

* **Response (200 OK - JSON):**
```json
{
  "id": 4,
  "nombre": "venta-tickets",
  "anulado": false,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:09:00.000Z"
}
```

---

### 4.5 `DELETE /modulos/:id` (Anular Módulo)
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 4,
  "nombre": "venta-tickets",
  "anulado": true,
  "fechaCreacion": "2026-07-24T14:03:35.000Z",
  "fechaActualizacion": "2026-07-24T14:10:00.000Z"
}
```

---

## 5. Acciones (`/acciones`)

### 5.1 `POST /acciones` (Crear Acción)
* **Request Body (JSON):**
```json
{
  "nombre": "exportar"
}
```

* **Response (201 Created - JSON):**
```json
{
  "id": 5,
  "nombre": "exportar"
}
```

---

### 5.2 `GET /acciones` (Listar Acciones)
* **Response (200 OK - JSON):**
```json
[
  { "id": 1, "nombre": "ver" },
  { "id": 2, "nombre": "crear" },
  { "id": 3, "nombre": "editar" },
  { "id": 4, "nombre": "anular" },
  { "id": 5, "nombre": "exportar" }
]
```

---

### 5.3 `GET /acciones/:id` (Obtener Acción por ID)
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 5,
  "nombre": "exportar"
}
```

---

### 5.4 `PATCH /acciones/:id` (Actualizar Acción)
* **Path Params:** `id` (número entero)
* **Request Body (JSON):**
```json
{
  "nombre": "exportar-pdf"
}
```

* **Response (200 OK - JSON):**
```json
{
  "id": 5,
  "nombre": "exportar-pdf"
}
```

---

### 5.5 `DELETE /acciones/:id` (Eliminar Acción)
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 5,
  "nombre": "exportar-pdf"
}
```

---

## 6. Módulo-Acciones (`/modulo-acciones`)

### 6.1 `POST /modulo-acciones` (Vincular Módulo con Acción)
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
    "nombre": "usuarios",
    "anulado": false,
    "fechaCreacion": "2026-07-24T14:00:00.000Z",
    "fechaActualizacion": "2026-07-24T14:00:00.000Z"
  },
  "accion": {
    "id": 4,
    "nombre": "anular"
  }
}
```

---

### 6.2 `GET /modulo-acciones` (Listar Asociaciones Módulo-Acción)
* **Response (200 OK - JSON):**
```json
[
  {
    "id": 12,
    "idModulo": 1,
    "idAccion": 4,
    "modulo": { "id": 1, "nombre": "usuarios", "anulado": false },
    "accion": { "id": 4, "nombre": "anular" }
  }
]
```

---

### 6.3 `GET /modulo-acciones/modulo/:idModulo` (Obtener Acciones por ID de Módulo)
* **Path Params:** `idModulo` (número entero)
* **Response (200 OK - JSON):**
```json
[
  {
    "id": 12,
    "idModulo": 1,
    "idAccion": 4,
    "accion": { "id": 4, "nombre": "anular" }
  }
]
```

---

### 6.4 `GET /modulo-acciones/:id` (Obtener por ID)
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 12,
  "idModulo": 1,
  "idAccion": 4,
  "modulo": { "id": 1, "nombre": "usuarios", "anulado": false },
  "accion": { "id": 4, "nombre": "anular" }
}
```

---

### 6.5 `DELETE /modulo-acciones/:id` (Eliminar Vinculación)
* **Path Params:** `id` (número entero)
* **Response (200 OK - JSON):**
```json
{
  "id": 12,
  "idModulo": 1,
  "idAccion": 4
}
```
