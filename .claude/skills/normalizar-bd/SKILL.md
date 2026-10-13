---
name: normalizar-bd
description: Revisa el esquema de Prisma/SQL Server contra 1FN, 2FN y 3FN, distingue las violaciones reales de las desnormalizaciones deliberadas, y propone un plan de refactorización por pasos reversibles. Usar cuando se pida "normalizar la base", "revisar el esquema", "3FN", "formas normales", "hay redundancia en las tablas", "rediseñar el modelo de datos" o "la base está mal diseñada".
---

# Normalización del esquema

Audita `prisma/schema.prisma` (Prisma 6 sobre SQL Server) contra las tres primeras formas normales y propone cómo corregir lo que esté mal. El esquema tiene 30+ modelos y sostiene dinero: tickets, arqueos de caja, donaciones y una bitácora de auditoría.

**El entregable por defecto es un informe, no un cambio.** Refactorizar solo después de que el usuario apruebe el plan, tabla por tabla.

---

## Regla inviolable: nunca borrar datos

La base de desarrollo (`parque_tickets`) tiene **datos reales y no reproducibles**. Prohibido sin excepción:

- `prisma.<modelo>.delete()` / `.deleteMany()`
- `DELETE FROM`, `TRUNCATE`, `DROP TABLE`, `DROP COLUMN`
- `prisma migrate reset`, `prisma db push --force-reset`, `prisma migrate dev`

`prisma migrate dev` está prohibido aparte: el repositorio tiene **drift** entre la migración inicial y el esquema actual, y esa orden puede pedir un reset que destruye todo.

El esquema se aplica **solo** con `npx prisma db push`, sin `--accept-data-loss`. Si Prisma advierte pérdida de datos, **detenerse y reportarlo**: esa advertencia es la señal de que el paso está mal planteado, no un trámite.

Normalizar suele implicar partir tablas. Partir una tabla **nunca** es "crear la nueva y borrar la vieja": ver «Migración por expansión» abajo.

---

## Lo primero: no todo lo que parece violar la 3FN lo viola

**Este es el criterio que decide si la skill ayuda o destruye.** Gran parte de la redundancia de este esquema es deliberada y sostiene algo. Un pase ingenuo de 3FN la "arreglaría" y rompería la auditoría, el arqueo o el histórico de precios.

Antes de marcar una columna como violación, comprobar si cae en alguna de estas categorías:

### 1. Valor histórico congelado

Un dato que **describe el momento en que ocurrió algo** no depende de la tabla de referencia, aunque se le parezca. Recalcularlo desde el catálogo actual da una respuesta distinta, y equivocada.

- `VisitantePorTicket.precioUnitario` y `subtotal` — lo que se cobró ese día. La `Tarifa` de hoy puede ser otra. **No es transitiva: es un hecho.**
- `Ticket.montoTotal` — lo que entró al cajón.
- `CierreCaja.montoEsperado` y `diferencia` — calculados al cerrar y congelados; el arqueo es inmutable por diseño.

Señal para reconocerlos: la tabla de referencia tiene vigencia (`vigenteDesde` / `vigenteHasta`) o la fila es un asiento contable.

### 2. Copia defensiva para auditoría

- `Bitacora.usuarioNombre` — copia del nombre del ejecutor. La relación `usuario` es `onDelete: SetNull`, así que si el usuario desaparece la bitácora **tiene que seguir diciendo quién fue**. Quitar esta columna en nombre de la 3FN destruye el valor probatorio del registro entero.

Señal: la relación es opcional o `SetNull`, y la tabla es un registro de auditoría.

### 3. Contador materializado con propósito

- `DispositivoTaquilla.ultimoCorrelativo` y `foliosRendidos` — su **resta** es lo que delata folios emitidos de los que nadie respondió. Derivarlos contando filas da el mismo número pero pierde el caso que importa: un folio que se emitió y nunca llegó no existe como fila que contar.
- `Correlativo.ultimoNumero` — reserva el siguiente folio bajo transacción `Serializable`. Es un mecanismo de concurrencia, no un caché.

Señal: el contador se usa para detectar **ausencias**, o para serializar.

> Si una columna cae en estas tres categorías, **no es una violación**. Anotarla en el informe como «desnormalización deliberada» con su justificación, y seguir.

El inventario completo está en `references/desnormalizaciones.md`. Revisarlo **antes** de proponer cualquier cambio.

---

## Qué sí buscar

### 1FN — valores atómicos

- Columnas de texto que guarden listas (`"1,2,3"`), JSON con estructura consultable, o pares clave-valor.
- Grupos repetidos en columnas numeradas (`telefono1`, `telefono2`).
- `NVarChar(Max)` que en realidad contenga campos separados por un delimitador.

Comprobación: `grep -n "NVarChar(Max)" prisma/schema.prisma` y revisar qué escribe cada uno en el código.

### 2FN — dependencia de la clave completa

Solo aplica a tablas con **clave compuesta**. En este esquema casi todas usan `id` autoincremental, así que la 2FN rara vez se viola; revisar las que tienen `@@unique` compuesto usado como identidad real:

- `Permisos` — `@@unique([idUsuario, idModuloAccion])`
- `VisitantePorTicket` — `@@unique([idTicket, idTipoVisitante])`
- `Correlativo` — `@@unique([serie, anio])`

Pregunta: ¿hay algún atributo que dependa de **una parte** de esa clave y no del conjunto?

### 3FN — sin dependencias transitivas

Un atributo no clave que dependa de otro atributo no clave. **Aquí es donde hay que aplicar el filtro de arriba**: la mayoría de los candidatos de este esquema son históricos o defensivos.

Lo que sí sería violación real: una columna que duplique un dato **mutable y actual** de otra tabla, sin razón histórica. Por ejemplo, guardar el nombre actual de una atracción dentro de `Ticket`: si se renombra la atracción, el ticket mostraría un nombre viejo sin que eso signifique nada.

---

## Método

1. **Leer el esquema entero** antes de opinar. `prisma/schema.prisma`, de arriba a abajo. Los comentarios `///` explican decisiones y muchos anticipan la pregunta.
2. **Leer `references/desnormalizaciones.md`** y descartar lo que ya esté justificado allí.
3. **Para cada candidato restante, buscar quién lo escribe y quién lo lee** (`grep -rn "<columna>" src`). Una columna que nadie lee es un hallazgo distinto —y más fácil— que una redundancia real.
4. **Comprobar contra datos reales** si la redundancia ya divergió:
   ```sql
   SELECT COUNT(*) FROM Tabla t JOIN Referencia r ON ... WHERE t.copia <> r.original
   ```
   Cero divergencias con años de datos sugiere que algo la mantiene sincronizada. Divergencias sugieren que la copia es histórica **o** que hay un bug: distinguir cuál antes de proponer nada.
5. **Escribir el informe.** Solo entonces preguntar si se refactoriza.

---

## Informe

Una tabla con una fila por hallazgo:

| Tabla.columna | Forma | Qué pasa | Evidencia | Propuesta | Riesgo |
|---|---|---|---|---|---|

Reglas del informe:

- **Cada hallazgo con evidencia**: `archivo:línea` del esquema, y del código que lo escribe o lo lee.
- **Separar en tres bloques**: violaciones reales, desnormalizaciones deliberadas (con su justificación), y dudosas que necesitan decisión del usuario.
- **Nunca afirmar que algo es redundante sin haber buscado quién lo usa.** Una columna puede parecer derivada y ser el único registro de un hecho.
- Si el esquema ya cumple, decirlo claramente. Un informe sin hallazgos es un resultado válido y bastante probable en este esquema.

---

## Migración por expansión, si se aprueba un cambio

Partir o mover una columna **nunca** se hace de un tirón. Cuatro pasos, cada uno desplegable y reversible:

1. **Expandir** — crear la tabla o columna nueva. Nada la lee todavía. `db push` sin pérdida.
2. **Rellenar** — copiar los datos con un script en `prisma/`, idempotente, que solo escriba lo que falte. Verificar el conteo contra el origen.
3. **Migrar lectores** — el código pasa a leer de lo nuevo. La columna vieja sigue ahí, sincronizada.
4. **Contraer** — dejar de escribir en la vieja. **Borrar la columna es una decisión aparte del usuario**, no el cierre automático del paso 4. Una columna sin usar no le hace daño a nadie; borrarla sí puede.

Entre el 2 y el 3, verificar con una consulta que ambas fuentes coinciden fila por fila. Si no coinciden, el paso 2 está mal y hay que arreglarlo antes de seguir.

**Cada paso necesita sus pruebas.** El repositorio tiene 500+ en `npm test`; si un refactor no rompe ninguna, sospechar que falta cobertura, no celebrar.

---

## Comandos

```bash
npx prisma validate          # el esquema compila
npx prisma db push           # aplicar, SIN --accept-data-loss
npm run build                # el cliente y los tipos siguen bien
npm test                     # 500+ pruebas; deben quedar todas en verde
```

Tras `db push` puede fallar `prisma generate` con `EPERM` si el backend está corriendo: tiene bloqueada la DLL del motor. Los tipos suelen generarse igual; si no, pedir al usuario que detenga el proceso del puerto 4000.

Los índices de `prisma/sql/*.sql` **no** están en el esquema y se pierden con algunos cambios: si se tocan `Ticket`, `TicketPago`, `Donacion`, `LoteOffline` o `FolioReservado`, revisar si hay que reaplicarlos con `prisma/aplicar-indices-reportes.ts`.
