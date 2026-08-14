---
name: qa-produccion
description: Auditoría QA estricta de un módulo del backend antes de integrarlo a producción — lógica de negocio, pruebas unitarias y e2e con Jest, protección de rutas y permisos, y seguridad (XSS, inyección SQL, validación de entrada). Emite un veredicto APTO / NO APTO con evidencia. Usar cuando se pida "probar", "test de QA", "validar el módulo", "revisar seguridad", "XSS", "inyección SQL", o "¿está listo para producción?".
---

# QA de producción

Auditoría de un módulo del backend Aktun Kan (NestJS 11 + Prisma/SQL Server) para decidir si es apto para producción. No es una revisión de estilo: cada afirmación del reporte final debe estar respaldada por un comando ejecutado o una línea de código citada (`archivo:línea`).

## Regla inviolable: nunca borrar registros

Las pruebas corren contra la base de datos de desarrollo (`parque_tickets`), que contiene datos **críticos y no reproducibles**. Está terminantemente prohibido:

- `prisma.<modelo>.delete()` / `.deleteMany()` en tests, scripts o comandos manuales
- `DELETE FROM`, `TRUNCATE`, `DROP` por SQL directo
- `prisma migrate reset`, `prisma db push --force-reset`, `prisma migrate dev` (puede pedir reset por el drift existente del repositorio)

Para limpiar datos de prueba se usa **solo soft delete**: `anulado: true`, o el endpoint `DELETE /<recurso>/:id` del propio módulo **solo si se verificó que internamente hace soft delete**.

### Endpoints con borrado duro — nunca invocar contra la BD de desarrollo

No todos los `DELETE` son baja lógica. Estos destruyen datos de forma irreversible y en cascada:

| Endpoint | Efecto real |
|---|---|
| `DELETE /acciones/:id` | `src/acciones/acciones.service.ts:126-137` — borra los `Permisos` de **todos los usuarios** que usen esa acción, los `ModuloAccion` vinculados y la `Accion`. Deja usuarios sin permisos, sin forma de revertir. |
| `DELETE /modulo-acciones/:id` | `src/modulo-acciones/modulo-acciones.service.ts:142-146` — borra los `Permisos` asociados y la vinculación módulo-acción. |
| `POST /usuarios/:id/permisos` | `src/usuarios/usuarios.service.ts:379` — reemplaza permisos borrando los previos. Cambia permisos reales de un usuario real. |

Probar estas rutas requiere **mocks (Fase 2), nunca e2e contra la BD real**. Si el módulo bajo prueba es `Acciones`, `ModuloAcciones` o los permisos de `Usuarios`, limitarse a pruebas unitarias y decirlo en el reporte.

Que un `DELETE` haga borrado duro donde el resto del sistema usa `anulado` es además un hallazgo a reportar por sí mismo.

Reglas de higiene adicionales:

- Prefijar todo dato de prueba con `QA-TEST-` (ej. `nombre: 'QA-TEST-Insumos'`) para que sea identificable.
- Si se cambia el esquema, aplicarlo con `prisma db push` (nunca `migrate reset`).
- **Estado global de caja:** solo puede existir una caja abierta en todo el sistema. Antes de probar `Cajas`, consultar `GET /cajas/actual`; si hay una caja real abierta, **no** abrir otra — reportar el bloqueo y probar contra esa o solo con mocks. Al terminar, dejar el estado como estaba (cerrar o anular la caja de prueba); una caja de prueba abierta olvidada bloquea la operación real.

## Fase 0 — Preparación

1. `npm run build`. Si falla, detenerse: no hay nada que probar hasta que compile.
2. Identificar el alcance: archivos del módulo (`*.controller.ts`, `*.service.ts`, `dto/`) y su modelo en `prisma/schema.prisma`.
3. Enumerar las **reglas de negocio declaradas** del módulo leyendo el servicio (excepciones lanzadas, condiciones, invariantes). Esa lista es el contrato a probar; cada regla necesita al menos un test que la confirme y uno que confirme su violación.

## Fase 1 — Auditoría de protección de rutas

`JwtAuthGuard` y `PermissionsGuard` son globales (`APP_GUARD` en `app.module.ts`), pero **el diseño es fail-open**: en `src/auth/guards/permissions.guard.ts:38-40`, si un handler no declara `@RequirePermission`, el guard retorna `true` y la ruta queda accesible a **cualquier usuario autenticado**.

Por cada handler del controlador, verificar que tenga `@RequirePermission(modulo, accion)` o `@Public()` de forma explícita. Un handler sin ninguno de los dos es un **hallazgo crítico**, no un descuido menor.

Verificar además:
- La acción declarada corresponde al efecto real (lectura → `Ver`, escritura → `Crear`/`Editar`, baja → `Anular`). Un `DELETE` protegido con `Ver` es un hallazgo.
- El módulo referenciado existe como fila en `Modulo`, con sus `ModuloAccion` vinculados. Si no existe, **nadie** puede usar esas rutas: reportarlo como bloqueo de despliegue.
- Rutas `@Public()`: confirmar que la exposición sin autenticación es intencional.

## Fase 2 — Pruebas unitarias de lógica de negocio

Specs `*.spec.ts` junto al servicio (`rootDir` es `src`, `testRegex` es `.*\.spec\.ts$`). Prisma **siempre mockeado** en esta fase: son rápidas, deterministas y no tocan la BD. Ver `references/plantillas.md` para el mock de `PrismaService` con `$transaction`.

Cubrir, por cada método de escritura:
- **Camino feliz**: devuelve lo esperado y llama a Prisma con los argumentos correctos.
- **Cada excepción declarada**: `ConflictException`, `NotFoundException`, `BadRequestException` — provocarla y verificar tipo y mensaje.
- **Cálculos**: probar con valores límite (0, negativos, decimales). En `cajas`, el arqueo (`montoInicial + ventas efectivo − gastos`) y la `diferencia` (sobrante y faltante) son el núcleo: verificar aritmética con `Decimal` de Prisma convertido a número, no confiar en la coincidencia de tipos.
- **Invariantes del proyecto** (aplican a todos los módulos):
  - La escritura ocurre dentro de `prisma.$transaction`.
  - Se registra en bitácora vía `BitacoraService.registrarEnTransaccion(tx, ...)` **dentro** de la misma transacción, con el `modulo` y `accion` correctos.
  - Baja lógica (`anulado: true`), nunca `delete`.
  - Timestamps con `getFechaUTC6()` (`src/common/utils/date.util.ts`), no `new Date()` directo.

Ejecutar: `npm test -- <ruta-del-spec>` y luego `npm test` completo para descartar regresiones.

## Fase 3 — Pruebas e2e de rutas y permisos

Specs `*.e2e-spec.ts` en `test/`, ejecutadas con `npm run test:e2e` (config `test/jest-e2e.json`). Aquí sí se levanta la app real con supertest.

Por cada ruta protegida, los tres casos de autorización:
1. Sin token → **401**
2. Con token de un usuario **sin** el permiso → **403**
3. Con token de un usuario **con** el permiso → 2xx

Además:
- Flujo completo del módulo en orden real (para `cajas`: apertura → gasto → arqueo → cierre → anular cierre → reabrir), verificando que el estado quede consistente.
- Violación de invariantes vía HTTP: doble apertura → 409; doble cierre → 400; anular apertura ya cerrada → 400.
- `ParseIntPipe`: `:id` no numérico → 400. ID inexistente → 404.
- Aplicar la regla de limpieza: anular (nunca borrar) lo creado y restaurar el estado de caja.

## Fase 4 — Seguridad

### Inyección SQL
Prisma parametriza todas las consultas del cliente generado; la única vía de inyección es SQL crudo. Verificación de regresión:

```bash
grep -rn '\$queryRaw\|\$executeRaw\|queryRawUnsafe\|executeRawUnsafe' src/
```

Hoy el resultado esperado es **vacío**. Cualquier aparición de `$queryRawUnsafe` / `$executeRawUnsafe` con datos del usuario es un hallazgo crítico; `$queryRaw` con template literal es seguro (parametriza) pero debe justificarse.

Prueba activa: enviar `' OR 1=1--`, `'; DROP TABLE Usuario;--` y `1 UNION SELECT null` en campos de texto y en query params. Esperado: se almacenan como texto literal o los rechaza la validación; nunca alteran el resultado de la consulta ni provocan un 500.

### XSS
La API responde JSON, así que el riesgo real es **XSS almacenado**: el backend guarda cadenas y el frontend las pinta. Enviar en cada campo de texto (`nombre`, `descripcion`, `observaciones`):

- `<script>alert(1)</script>`
- `<img src=x onerror=alert(1)>`
- `"><svg/onload=alert(1)>`
- `javascript:alert(1)`

Verificar:
- La respuesta sale con `Content-Type: application/json` (no `text/html`) — es lo que evita el XSS reflejado.
- El valor se devuelve tal cual se guardó, sin corromper el JSON.
- El campo tiene `@MaxLength` en su DTO. Un campo de texto libre sin límite es un hallazgo (permite almacenar payloads grandes); revisar en particular los `observaciones` de `cajas`.
- **Mensajes de error que reflejan la entrada**: varios servicios interpolan el dato del usuario en la excepción (ej. `Ya existe un puesto registrado con el nombre '${dto.nombre}'`). En JSON no es explotable directamente, pero debe reportarse como riesgo si el frontend lo inserta con `innerHTML`.
- **Correos HTML** (`src/mail/mail.service.ts`): si interpola datos del usuario en el cuerpo HTML, es inyección de HTML en un contexto que **sí** renderiza. Revisar y reportar.

### Validación y superficie de entrada
El `ValidationPipe` global (`src/main.ts`) usa `whitelist`, `forbidNonWhitelisted` y `transform`. Probar:
- Campo extra no declarado en el DTO → **400** (confirma que `forbidNonWhitelisted` está activo).
- Tipos incorrectos (string donde va número, número negativo donde se exige `@Min`) → 400.
- **Asignación masiva**: intentar enviar `id`, `anulado`, `fechaCreacion` o FKs no permitidas en un `PATCH`; el servicio hace `data: { ...dto }`, así que todo campo declarado en el DTO es escribible. Confirmar que eso es intencional.
- `enableImplicitConversion: true` puede coercionar tipos de forma inesperada (`"5"` → `5`, `"abc"` → `NaN`): probar entradas ambiguas en campos numéricos.

### Configuración
Revisar y reportar (sin cambiarlo salvo que se pida):
- `enableCors({ origin: '*' })` en `src/main.ts` — aceptable con JWT en header, riesgoso si en el futuro se usan cookies.
- Duración del JWT: `recordarme: true` emite tokens de **365 días**; sin revocación, un token filtrado vive un año.
- Confirmar que `.env` sigue fuera del control de versiones (`git ls-files --error-unmatch .env` debe fallar) y que ningún secreto está hardcodeado en `src/`.

## Fase 5 — Veredicto

Clasificar cada hallazgo:
- **Crítico** — ruta sin permiso declarado, inyección posible, pérdida o corrupción de datos, invariante de negocio violable. Bloquea producción.
- **Mayor** — regla de negocio sin cobertura, error no manejado (500), permiso incorrecto, falta de bitácora en una escritura.
- **Menor** — validación faltante sin impacto explotable, mensajes, límites de longitud.

Veredicto:
- **APTO** — sin críticos ni mayores; suites en verde.
- **APTO CON RESERVAS** — sin críticos; mayores documentados y aceptados explícitamente por el usuario.
- **NO APTO** — al menos un crítico, o suites en rojo, o cobertura insuficiente de las reglas declaradas.

Reportar en este formato:

```
VEREDICTO: <APTO | APTO CON RESERVAS | NO APTO>

Comandos ejecutados:  <comando> → <resultado real>
Cobertura:            <reglas probadas> / <reglas declaradas>

Hallazgos:
[CRÍTICO] <archivo:línea> — <qué falla> — <cómo reproducirlo>
[MAYOR]   ...
[MENOR]   ...

Datos de prueba creados: <IDs y estado final (anulados / caja restaurada)>
No verificado: <lo que no se pudo probar y por qué>
```

Reglas del reporte:
- Nunca declarar APTO sin haber ejecutado las suites y pegado su resultado real.
- Si un test falla, decirlo con la salida; no reinterpretarlo como aprobado.
- Listar explícitamente lo que quedó sin verificar (ej. bloqueado por una caja abierta real).
