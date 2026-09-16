# Módulo de Reportes — Guía para el Frontend

Todo lo que hace falta para integrar `/reportes`. Los ejemplos usan `fetch` sin
dependencias; adáptalos a tu cliente HTTP.

> **Base:** `http://localhost:4000` en desarrollo. No hay prefijo global: las rutas son
> `/reportes`, no `/api/reportes`.
> **Autenticación:** todas las rutas exigen `Authorization: Bearer <access_token>`.

---

## Índice

1. [Lo esencial en un minuto](#1-lo-esencial-en-un-minuto)
2. [Permisos que necesita el usuario](#2-permisos-que-necesita-el-usuario)
3. [`GET /reportes` — construir el menú](#3-get-reportes--construir-el-menú)
4. [Los 19 reportes](#4-los-19-reportes)
5. [Construir el formulario de filtros](#5-construir-el-formulario-de-filtros)
6. [`GET /reportes/:clave` — ejecutar y pintar la tabla](#6-get-reportesclave--ejecutar-y-pintar-la-tabla)
7. [Cómo pintar la respuesta](#7-cómo-pintar-la-respuesta)
8. [Descargar el PDF y el Excel](#8-descargar-el-pdf-y-el-excel)
9. [`POST /reportes/interpretar` — pedir un reporte escribiendo](#9-post-reportesinterpretar--pedir-un-reporte-escribiendo)
10. [Manejo de errores](#10-manejo-de-errores)
11. [Ejemplo completo](#11-ejemplo-completo)
12. [Checklist de integración](#12-checklist-de-integración)

---

## 1. Lo esencial en un minuto

El módulo tiene **dos vías** y conviene no confundirlas:

| | Vía predeterminada | Vía a medida |
|---|---|---|
| Ruta | `GET /reportes/:clave` (+ `/pdf`, `/excel`) | `POST /reportes/interpretar` |
| Qué es | Los **19 reportes del catálogo**, con botones y filtros | Una caja de texto donde el usuario escribe lo que quiere |
| ¿Sale a internet? | **Nunca** | Sí, una vez |
| ¿Consume cuota? | No | Sí |
| Si el servicio de IA falla | Sigue funcionando | `503` |

**Los botones y filtros de tus pantallas deben pegar siempre a la vía predeterminada.**
La caja de texto es un extra para cuando alguien necesita algo que no está en el catálogo.

Las tres salidas de un mismo reporte:

```
GET /reportes/ventas-por-vendedor?desde=2026-08-01&hasta=2026-08-31          → JSON  (tabla en pantalla)
GET /reportes/ventas-por-vendedor/pdf?desde=2026-08-01&hasta=2026-08-31      → PDF   (imprimir)
GET /reportes/ventas-por-vendedor/excel?desde=2026-08-01&hasta=2026-08-31    → XLSX  (filtrar y sumar)
```

Misma query string; solo cambia la extensión. El selector PDF/Excel de tu pantalla es
elegir a cuál de las dos URL ir.

---

## 2. Permisos que necesita el usuario

Son **dos capas**, y las dos tienen que cumplirse:

1. `Reportes` + `Ver` — para ver el catálogo y ejecutar en JSON.
2. `Reportes` + `Exportar` — para descargar PDF o Excel.
3. Además, `Ver` sobre el módulo dueño de los datos de cada reporte
   (`EmisionTickets`, `Cajas`, `Donaciones`, `Bitacora`, `Usuarios` o
   `ActividadesParque`).

**No tienes que comprobar nada de esto tú.** `GET /reportes` ya devuelve solo los
reportes que ese usuario puede ejecutar; si pintas el menú desde ahí, nunca le vas a
mostrar un botón que le vaya a responder `403`.

> Si al usuario le sale el menú vacío, le falta `Reportes.Ver` o el permiso del módulo de
> origen. No es un error tuyo.

**Un detalle que sí afecta al render:** las columnas del arqueo (`montoEsperado`,
`diferencia`) solo llegan si el usuario tiene `Cajas` + `Editar`. A quien no lo tiene, esas
columnas **no vienen en la respuesta**: ni en `columnas`, ni como clave dentro de las
filas. Por eso nunca hay que dar por hecho que una columna existe — se pinta lo que venga
en `columnas` (ver §7).

---

## 3. `GET /reportes` — construir el menú

Es la primera llamada de la pantalla. Devuelve el catálogo filtrado por permisos.

```http
GET /reportes
Authorization: Bearer <token>
```

```json
{
  "datos": [
    {
      "clave": "ventas-por-vendedor",
      "titulo": "Ventas por vendedor",
      "descripcion": "Cuánto vendió cada cajero o vendedor en el período: tickets emitidos, personas atendidas, total recaudado y qué porcentaje del total representa...",
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
          "descripcion": "Nombre del cajero o usuario que emitió la venta.",
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

| Campo | Para qué te sirve |
|---|---|
| `clave` | Va en la URL al ejecutar |
| `titulo` | Texto del botón o del ítem del menú |
| `descripcion` | Tooltip o subtítulo de la tarjeta |
| `categoria` | Agrupar el menú: `Tickets`, `Cajas`, `Donaciones`, `Bitácora`, `Usuarios`, `Actividades` |
| `orientacion` | `horizontal` avisa de que la tabla es ancha: conviene scroll horizontal o menos columnas en móvil |
| `filtros` | Los controles del formulario (ver §5) |
| `interpretacionDisponible` | Si es `false`, **no pintes la caja de texto de la vía a medida**: no hay clave configurada y siempre daría `503` |

Agrupa por `categoria` para el menú. El orden que devuelve el backend ya viene agrupado.

---

## 4. Los 19 reportes

| Clave | Categoría | Qué responde |
|---|---|---|
| `ventas-resumen` | Tickets | Recaudado, tickets, personas y ticket promedio, con una fila por día |
| `ventas-por-vendedor` | Tickets | Cuánto vendió cada cajero y su % del total |
| `ventas-por-atraccion` | Tickets | Cuevas vs. mariposario + sección por tipo de recorrido |
| `ventas-por-tipo-visitante` | Tickets | Adultos, niños, niños menores y centros educativos |
| `ventas-por-origen` | Tickets | Nacional vs. extranjero + sección por país |
| `ventas-por-forma-pago` | Tickets | Efectivo vs. tarjeta, separando `PAGADO` / `PENDIENTE` / `CANCELADO` |
| `ventas-detalle` | Tickets | El libro de ventas: un renglón por ticket |
| `tickets-anulados` | Tickets | Qué se anuló, cuándo, por cuánto y quién lo emitió |
| `cajas-turnos` | Cajas | Turnos con apertura, cierre, inicial y contado (+ arqueo si supervisa) |
| `arqueo-de-caja` | Cajas | Arqueo detallado de un turno. **Solo supervisor**; exige el filtro `caja` |
| `donaciones-resumen` | Donaciones | Recaudado por día y por usuario que recibió |
| `donaciones-detalle` | Donaciones | Listado de recibos, con los anulados marcados |
| `bitacora-detalle` | Bitácora | Registro cronológico de acciones del sistema |
| `bitacora-resumen` | Bitácora | Conteo de acciones por módulo, usuario y tipo |
| `usuarios-listado` | Usuarios | Padrón con puesto, estado, alta y último acceso |
| `usuarios-permisos` | Usuarios | Matriz de permisos: fila por usuario, columna por módulo |
| `actividades-listado` | Actividades | Actividades con sector, responsable y estado |
| `actividades-por-sector` | Actividades | Conteo por sector y por responsable |
| `ventas-a-medida` | Tickets | **El único sin forma fija**: agrupa por lo que se le pida (ver abajo) |

### `ventas-a-medida`

Es el reporte que responde lo que el catálogo no anticipó. En vez de una agrupación fija,
recibe cuatro parámetros propios además de los filtros normales de venta:

| Parámetro | Obligatorio | Valores |
|---|---|---|
| `dimension` | sí | **catálogos:** `vendedor`, `atraccion`, `origen`, `pais`, `tipoRecorrido`, `guia` · **tiempo:** `dia`, `semana`, `mes`, `diaSemana`, `horaDelDia` |
| `dimension2` | no | los mismos; convierte la tabla en un cruce (filas × columnas) |
| `metrica` | no | `total` (predeterminado), `tickets`, `personas` |
| `diaSemana` | no | `lunes`…`domingo`: deja **solo** las ventas de ese día |
| `tope` | no | número de filas a mostrar, ya ordenadas de mayor a menor |

No confunda `diaSemana` como **filtro** con `dimension: diaSemana` como
**agrupación**: el primero deja solo los sábados, el segundo desglosa los siete días.
«Qué guía trabajó más los sábados» son las dos cosas a la vez: `dimension=guia` +
`diaSemana=sabado`.

```
GET /reportes/ventas-a-medida?desde=…&hasta=…&dimension=guia
GET /reportes/ventas-a-medida?desde=…&hasta=…&dimension=vendedor&tope=5
GET /reportes/ventas-a-medida?desde=…&hasta=…&dimension=atraccion&dimension2=pais
GET /reportes/ventas-a-medida?desde=2026-08-01&hasta=2026-09-30&dimension=mes&metrica=tickets
```

Es lo que cubre «ventas por guía», «los 5 que más recaudaron», «por atracción y por
país» y **«cuántos tickets en agosto y en septiembre»**, que ningún otro reporte puede
dar: el desglose por día de `ventas-resumen` devuelve los dos meses mezclados.

Las agrupaciones de tiempo **se ordenan cronológicamente**, no por valor — una tabla de
meses ordenada por recaudación es ilegible. La excepción es cuando se manda `tope`, que
es justamente pedir un ranking («las 3 horas de más venta»). **No hay que pintarle una pantalla especial**:
sus cuatro parámetros llegan como filtros normales en el catálogo, con `tipo: 'opciones'`
(los valores admitidos vienen en `opciones`) y `tipo: 'numero'`, así que el formulario
genérico de §5 los dibuja solo.

Con `dimension2` la respuesta es una **tabla cruzada**: las columnas se generan de los
datos, con claves numeradas (`c0`, `c1`, …) y el nombre del valor como título, más una
columna `otros` cuando hay más de diez valores distintos y una `totalFila`. Es la mejor
prueba de por qué la regla de §7 —no escribir claves de columna a mano— no es opcional.

Un `tope` **no marca el reporte como truncado**: recortar a los 5 primeros es lo que se
pidió, no una limitación del sistema. El aviso lo da la propia definición en `notas`.

Los que llevan **dos secciones** (`ventas-por-atraccion`, `ventas-por-origen`,
`donaciones-resumen`, `bitacora-resumen`, `actividades-por-sector`, `arqueo-de-caja`)
devuelven varias tablas en el mismo reporte. Tu componente tiene que iterar `secciones`,
no asumir que hay una sola.

---

## 5. Construir el formulario de filtros

Cada entrada de `filtros` describe **un control**. Lo importante:

- **`clave`** identifica el control en tu formulario.
- **`parametros`** son los nombres reales de la query string.
- **`opciones`** (solo en `tipo: 'opciones'`) trae los valores admitidos como
  `{ valor, etiqueta }`. Píntalos desde ahí y no desde una lista escrita en el frontend:
  así una dimensión nueva aparece en el formulario sin tocar la pantalla.

Casi siempre coinciden, pero **el rango de fechas es un control y dos parámetros**:
`clave: "periodo"` → `parametros: ["desde", "hasta"]`. Si mandas `periodo=...` te llevas un
`400`. Usa siempre `parametros` para armar la URL.

### Tipos de control

| `tipo` | Control | De dónde salen las opciones |
|---|---|---|
| `rangoFechas` | Selector de rango de fechas | — |
| `usuario` | Combo de usuarios | `GET /usuarios` |
| `atraccion` | Combo | `GET /tickets/catalogos` → `atracciones` |
| `origen` | Combo | `GET /tickets/catalogos` → `origenes` |
| `pais` | Combo con búsqueda | `GET /tickets/catalogos` → `paises` |
| `guia` | Combo con búsqueda | `GET /tickets/catalogos` → `guias` |
| `tipoVisitante` | Combo | `GET /tickets/catalogos` → `tiposVisitante` |
| `tipoRecorrido` | Combo | `GET /tickets/catalogos` → `tiposRecorrido` |
| `opcionPago` | Combo | `GET /tickets/catalogos` → `opcionesPago` |
| `aperturaCaja` | Combo de turnos | `GET /cajas` |
| `sector` | Combo | `GET /sectores` |
| `modulo` | Texto libre | — |
| `accion` | Texto libre | — |
| `booleano` | Checkbox | manda `"true"` o `"false"` |
| `opciones` | Combo de lista cerrada | **el propio filtro**, en su campo `opciones` |
| `numero` | Campo numérico | — |

`GET /tickets/catalogos` trae de una sola vez atracciones, orígenes, países, tipos de
visitante, tipos de recorrido, formas de pago y guías. Pídelo una vez y cachéalo.

### Reglas de los valores

- Los combos mandan el **id** (`vendedor=4`). También se acepta el **nombre**
  (`vendedor=Juan`), que el backend resuelve por coincidencia parcial — útil para una
  búsqueda rápida, pero desde el frontend usa el id: es exacto y no puede quedar ambiguo.
- Fechas en **`AAAA-MM-DD`**, ambas inclusive. `hasta=2026-08-31` incluye el 31 completo.
- Si omites `desde` y `hasta`, el backend usa **el mes en curso**.
- El rango **no puede pasar de 366 días**.
- **No mandes parámetros que el reporte no declara**: la API los rechaza con `400`
  diciendo cuáles acepta. Filtra tu objeto de query por los `parametros` del catálogo
  antes de enviarlo. No es una formalidad: un filtro que el reporte no declara no se
  aplicaría, pero sí saldría impreso en la cabecera como si se hubiera aplicado — y
  `diaSemana` solo lo saben expresar las consultas en SQL, así que llegar a un reporte
  que calcula con agregados de Prisma daría una cifra que no corresponde a sus chips.

```js
/** Arma la query string a partir de lo que declara el catálogo. */
function construirQuery(definicion, valores) {
  const params = new URLSearchParams();
  for (const filtro of definicion.filtros) {
    for (const nombre of filtro.parametros) {
      const valor = valores[nombre];
      if (valor !== undefined && valor !== null && valor !== '') {
        params.set(nombre, String(valor));
      }
    }
  }
  return params.toString();
}
```

---

## 6. `GET /reportes/:clave` — ejecutar y pintar la tabla

```http
GET /reportes/ventas-por-vendedor?desde=2026-08-01&hasta=2026-08-31
Authorization: Bearer <token>
```

Respuesta real del backend:

```json
{
  "clave": "ventas-por-vendedor",
  "titulo": "Ventas por vendedor",
  "periodo": {
    "desde": "2026-01-01",
    "hasta": "2026-12-31",
    "etiqueta": "1 de enero al 31 de diciembre de 2026"
  },
  "filtrosAplicados": [],
  "kpis": [
    { "etiqueta": "Recaudado", "valor": "Q315.00" },
    { "etiqueta": "Tickets emitidos", "valor": "13" },
    { "etiqueta": "Vendedores", "valor": "2" },
    { "etiqueta": "Ticket promedio", "valor": "Q24.23" }
  ],
  "secciones": [
    {
      "columnas": [
        { "clave": "grupo", "titulo": "Vendedor", "formato": "texto", "ancho": 0.32 },
        { "clave": "tickets", "titulo": "Tickets", "formato": "entero", "total": "suma" },
        { "clave": "personas", "titulo": "Personas", "formato": "entero", "total": "suma" },
        { "clave": "total", "titulo": "Total", "formato": "moneda", "total": "suma" },
        { "clave": "participacion", "titulo": "% del total", "formato": "porcentaje" }
      ],
      "filas": [
        { "grupo": "Giselle Pereira", "tickets": 11, "personas": 11, "total": "215.0000", "participacion": "0.682540" },
        { "grupo": "Romeo Santos", "tickets": 2, "personas": 5, "total": "100.0000", "participacion": "0.317460" }
      ],
      "totales": { "tickets": "13", "personas": "16", "total": "315.0000" }
    }
  ],
  "orientacion": "vertical",
  "notas": ["Los tickets anulados nunca suman al recaudado: ..."],
  "generadoEn": "2026-09-05T12:45:29.226Z",
  "generadoPor": "Romeo Santos",
  "truncado": false
}
```

### Campos del nivel superior

| Campo | Qué hacer con él |
|---|---|
| `titulo` | Encabezado de la pantalla |
| `subtitulo` | Opcional. Aclaración bajo el título |
| `periodo.etiqueta` | Ya viene en español legible; muéstralo tal cual |
| `filtrosAplicados` | Chips bajo el título: `"Vendedor: Juan Pérez"`. Si viene vacío, no se aplicó ninguno |
| `kpis` | Tarjetas de arriba. `valor` **ya viene formateado**: píntalo tal cual, no lo reformatees |
| `secciones` | Una tabla por elemento |
| `orientacion` | `horizontal` → la tabla es ancha; envuélvela en scroll horizontal |
| `notas` | Pie de la pantalla, en gris y letra pequeña |
| `generadoPor` / `generadoEn` | Pie: "Generado por X el Y" |
| `truncado` | Si es `true`, se alcanzó el tope de filas. **El motivo ya viene como primera nota**; muéstralo destacado |

---

## 7. Cómo pintar la respuesta

**La estructura es genérica a propósito.** Un solo componente de tabla sirve para los 19
reportes: `columnas` dice cómo formatear cada celda y tu código no necesita conocer ningún
reporte en concreto.

### Las cuatro reglas que no hay que romper

**1. Nunca hardcodees claves de columna.** Recorre `seccion.columnas` y usa
`fila[columna.clave]`. Las columnas de arqueo desaparecen para quien no supervisa, y las
del reporte `usuarios-permisos` se generan de la base (`modulo_3`, `modulo_7`…): cambian
según qué módulos existan.

**2. El dinero viaja como cadena decimal** (`"215.0000"`), no como número. Formatéalo, pero
**no lo sumes con `Number`**: los totales ya vienen calculados en `totales`.

**3. El porcentaje es una fracción.** `0.682540` se muestra como `68.3%`. Multiplica por 100.

**4. Una celda `null` es "sin dato".** Píntala como `—`, no en blanco: una celda vacía se
confunde con un cero perdido.

### Tabla de formato

| `formato` | Valor que llega | Cómo se muestra |
|---|---|---|
| `texto` | `"Giselle Pereira"` | Tal cual |
| `entero` | `11` | `11` con separador de miles |
| `decimal` | `"12.50"` | `12.50` (respeta `decimales`, 2 por defecto) |
| `moneda` | `"215.0000"` | `Q215.00` |
| `porcentaje` | `"0.682540"` | `68.3%` |
| `fecha` | `"2026-08-01"` | `2026-08-01` |
| `fechaHora` | `"2026-08-01 14:30"` | `2026-08-01 14:30` |

### Formateador de referencia

```js
const NUMERICOS = new Set(['entero', 'decimal', 'moneda', 'porcentaje']);

/** Alineación por omisión: los números a la derecha, el resto a la izquierda. */
function alineacion(col) {
  if (col.alineacion) {
    return { izquierda: 'left', centro: 'center', derecha: 'right' }[col.alineacion];
  }
  return NUMERICOS.has(col.formato) ? 'right' : 'left';
}

function formatearCelda(valor, col) {
  if (valor === null || valor === undefined || valor === '') return '—';

  const miles = (n, dec) =>
    Number(n).toLocaleString('es-GT', {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    });

  switch (col.formato) {
    case 'moneda':     return `Q${miles(valor, col.decimales ?? 2)}`;
    case 'decimal':    return miles(valor, col.decimales ?? 2);
    case 'entero':     return miles(valor, 0);
    // Llega como fracción; se lleva a 0-100 para leerlo.
    case 'porcentaje': return `${miles(Number(valor) * 100, col.decimales ?? 1)}%`;
    case 'fecha':      return String(valor).slice(0, 10);
    case 'fechaHora':  return String(valor).slice(0, 16).replace('T', ' ');
    default:           return String(valor);
  }
}
```

> `toLocaleString` sobre la cadena decimal es seguro para **mostrar**. Lo que no hay que
> hacer es acumular con `Number` para recalcular un total: el error de coma flotante se
> vuelve visible al sumar miles de ventas. Usa el `totales` que manda el backend.

### La fila de totales

`totales` es un objeto con **solo algunas claves**: las de las columnas que declaran
`total`. Píntala como una fila final en negrita, dejando en blanco las columnas que no
aparecen, y rotula la primera con `TOTAL`.

```jsx
<tr className="fila-totales">
  {seccion.columnas.map((col, i) => (
    <td key={col.clave} style={{ textAlign: alineacion(col) }}>
      {seccion.totales?.[col.clave] !== undefined
        ? formatearCelda(seccion.totales[col.clave], col)
        : i === 0 ? 'TOTAL' : ''}
    </td>
  ))}
</tr>
```

`totales` puede venir `null` o ausente (por ejemplo en `bitacora-detalle`): entonces no se
pinta la fila.

### Anchos

`ancho` es una **fracción del ancho total** (`0.32` = 32 %). Las columnas sin `ancho` se
reparten lo que sobre. `anchoMinimo` está en puntos de PDF; en web úsalo solo como pista
relativa, o ignóralo y deja que el navegador decida.

---

## 8. Descargar el PDF y el Excel

**Este es el punto donde más fácil es tropezar.** Las rutas exigen el header
`Authorization`, así que **no funcionan** con:

```js
window.open('/reportes/ventas-resumen/pdf?...');        // ❌ 401, no manda el token
<a href="/reportes/ventas-resumen/pdf?...">Descargar</a> // ❌ 401
```

Hay que pedirlo con `fetch`, quedarse con el *blob* y abrirlo o descargarlo:

```js
async function descargarReporte(clave, formato, query, token) {
  const respuesta = await fetch(`/reportes/${clave}/${formato}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!respuesta.ok) {
    // El cuerpo del error sí es JSON.
    const error = await respuesta.json().catch(() => ({}));
    throw new Error(error.message ?? `No se pudo generar el reporte (${respuesta.status}).`);
  }

  const blob = await respuesta.blob();
  const url = URL.createObjectURL(blob);

  if (formato === 'pdf') {
    // El PDF se sirve inline: se puede abrir en una pestaña o en un visor embebido.
    window.open(url, '_blank');
  } else {
    // El xlsx va como attachment: ningún navegador lo renderiza, hay que bajarlo.
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombreDeArchivo(respuesta) ?? `${clave}.xlsx`;
    enlace.click();
  }

  // Sin esto la pestaña acumula blobs en memoria.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Saca el nombre que propuso el servidor en Content-Disposition. */
function nombreDeArchivo(respuesta) {
  const cabecera = respuesta.headers.get('content-disposition') ?? '';
  return cabecera.match(/filename="([^"]+)"/)?.[1] ?? null;
}
```

> Si usas un proxy o CORS entre dominios, expón `Content-Disposition` con
> `Access-Control-Expose-Headers`, o `respuesta.headers.get(...)` devolverá `null` y
> tendrás que inventar el nombre.

### Qué esperar de cada formato

| | PDF | Excel |
|---|---|---|
| `Content-Type` | `application/pdf` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `Content-Disposition` | `inline` | `attachment` |
| Tope de filas | 5 000 | 50 000 |
| Para qué | Imprimir, archivar | Filtrar, sumar, tablas dinámicas |

El **PDF** trae logos, período, filtros aplicados, tarjetas de indicadores, una tabla por
sección con el encabezado repetido en cada página, fila de totales y «Página X de Y». La
orientación la decide el reporte.

El **Excel** trae una hoja `Resumen` con los indicadores y las notas, más una hoja por
sección. Los números son números de verdad, con formato de moneda: al seleccionar la
columna, Excel muestra la suma. Cada hoja lleva autofiltro, encabezados congelados y
totales con `SUBTOTAL` que se recalculan al filtrar dentro de la hoja.

> **Ofrece los dos.** Si el reporte tiene muchas filas, sugiere Excel: aguanta diez veces
> más que el PDF antes de recortar.

---

## 9. `POST /reportes/interpretar` — pedir un reporte escribiendo

Una caja de texto donde el usuario describe lo que necesita. **Píntala solo si
`interpretacionDisponible` es `true`.**

```http
POST /reportes/interpretar
Authorization: Bearer <token>
Content-Type: application/json

{ "instruccion": "ventas del vendedor Juan en las cuevas en agosto, desglosadas por día" }
```

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
  "resultado": { "...": "exactamente el mismo objeto de la §6" }
}
```

### Cómo integrarlo

1. **Muestra `interpretacion`** para que el usuario confirme que se le entendió. Es una
   frase en español, lista para pintar.
2. **Pinta `resultado`** con el mismo componente de tabla de la §7. No es una respuesta
   distinta: es el mismo objeto.
3. **Resalta el botón del formato que indica `formato`** (`"pdf"` salvo que la frase pidiera
   Excel explícitamente) y descarga contra **`urlDescarga`**.

`urlDescarga` ya es una URL de la vía predeterminada, con los ids resueltos. Eso significa:

- **La descarga no cuesta otra llamada al servicio de IA.** Ni la primera vez, ni al
  cambiar de PDF a Excel (basta con cambiar la extensión de esa URL).
- **Puedes ofrecer "guardar como favorito"**: guarda `urlDescarga` o `especificacion` y
  vuelve a ejecutarla siempre gratis. Es la forma de convertir una petición escrita en un
  botón permanente.

```js
// Cambiar de formato sin volver a llamar a la IA.
const urlExcel = respuesta.urlDescarga.replace('/pdf?', '/excel?');
```

### Límites y buenas prácticas

- La instrucción va de **5 a 500 caracteres**.
- **15 peticiones por minuto** por IP. Si te pasas, `429`.
- La cuota diaria del proveedor es limitada: no dispares la petición en cada tecla ni
  la uses como buscador. Un botón «Generar» explícito.
- El backend cachea la misma instrucción 10 minutos, así que repetirla no gasta cuota.

---

## 9.bis `GET /reportes/dashboard` — el panel de gráficas

Es **otra forma de datos**, no un reporte más: series listas para dibujar en vez de tablas
que además se imprimen. Alimenta la pestaña de solo gráficas, donde no hay que saber qué
reporte se quiere para ver cómo va el parque.

```http
GET /reportes/dashboard?desde=2026-01-01&hasta=2026-12-31
```

**Solo acepta `desde`, `hasta` y `grano`.** Cualquier otro parámetro devuelve 400:
aceptarlos daría a entender que todas sus gráficas los respetan. Sin fechas usa el mes en
curso.

`grano` (`dia` | `semana` | `mes`) es cada cuánto se agrupan las **series temporales**
—recaudación, tickets y donaciones—. **Si se omite lo elige el servidor** según lo que dure
el período, porque un año por días son 365 puntos: una mancha en la gráfica y un payload
que nadie mira.

| Duración del período | Grano |
|---|---|
| hasta 31 días | `dia` |
| hasta 120 días | `semana` |
| más | `mes` |

La respuesta trae `grano` y `granoAutomatico`, así que la pantalla puede decir con qué se
agrupó y si lo decidió el servidor. Las series de patrón (`ventas-por-hora`,
`ventas-por-dia-semana`) y las de distribución (atracción, origen, guías) no dependen del
grano.

```json
{
  "periodo":     { "desde": "…", "hasta": "…", "etiqueta": "1 de enero al 31 de diciembre de 2026" },
  "comparadoCon":{ "desde": "…", "hasta": "…", "etiqueta": "…" },
  "kpis": [
    { "clave": "recaudado", "etiqueta": "Recaudado", "valor": "Q315.00", "formato": "moneda",
      "variacion": { "porcentaje": 0.1938, "direccion": "sube", "etiqueta": "vs. 24 de julio al 14 de agosto" } }
  ],
  "grano": "mes",
  "granoAutomatico": true,
  "series": [
    { "clave": "ventas-por-periodo", "titulo": "Recaudación por mes", "tipoSugerido": "linea",
      "formato": "moneda", "unidad": "Recaudado", "total": "Q315.00",
      "puntos": [{ "etiqueta": "Agosto 2026", "valor": 290, "clave": "2026-08" }],
      "urlDetalle": "/reportes/ventas-a-medida?desde=…&hasta=…&dimension=mes" }
  ],
  "omitidos": [{ "panel": "Donaciones", "motivo": "Necesita el permiso Ver del módulo Donaciones." }],
  "generadoEn": "…", "generadoPor": "…"
}
```

Cómo pintarlo:

- **`kpis[].valor` ya viene formateado**, igual que en los reportes. `variacion.porcentaje`
  es una fracción (`0.1938` = 19.4 %) y **falta cuando el período anterior estuvo en cero**:
  no hay porcentaje que exprese pasar de nada a algo. Píntelo como «sin comparación», no
  como 0 %.
- **`puntos[].valor` es un número, no una cadena decimal.** Es la excepción a la regla del
  §7, y a propósito: una gráfica convierte a píxeles, no cuadra cuentas. Para no tener que
  sumarlos, la serie ya trae su `total` exacto calculado con Decimal en el servidor —
  **nunca sume los puntos para obtener el total**.
- **`tipoSugerido`** es lo que el backend recomienda viendo los datos (`linea`, `barra`,
  `dona`, `embudo`). Ofrezca cambiarlo, pero arranque por ahí.
- **`urlDetalle`** es el reporte del catálogo que muestra lo mismo en tabla, con los
  filtros ya puestos: es el salto natural de una gráfica al detalle imprimible.
- **`omitidos`** son los paneles que no se armaron por permisos. Muéstrelos con su motivo:
  un panel que desaparece sin explicación se lee como una avería.

El panel comparte las consultas de los reportes, así que sus cifras y las de un PDF del
mismo período coinciden por construcción.

## 10. Manejo de errores

El formato es el estándar de NestJS:

```json
{ "message": "…", "error": "Unprocessable Entity", "statusCode": 422 }
```

`message` puede ser **texto o un arreglo de textos** (cuando falla la validación de varios
campos a la vez). Normalízalo:

```js
const mensaje = Array.isArray(error.message) ? error.message.join(' ') : error.message;
```

| Código | Cuándo | Qué mostrar |
|---|---|---|
| `400` | Fecha mal formada, rango invertido, rango > 366 días, o un parámetro no declarado | El `message` tal cual: ya explica qué corregir |
| `401` | Falta el token o expiró | Refrescar sesión |
| `403` | Le falta el permiso del módulo de origen, o el reporte es solo de supervisor | El `message` dice qué permiso falta |
| `404` | La clave del reporte no existe | El `message` lista las válidas |
| `422` | Un filtro por nombre no se resolvió, o es ambiguo | **Muéstralo tal cual**: trae los candidatos (`"'Juan' coincide con varias opciones: Juan Pérez, Juan Ramos. Precise cuál."`) |
| `429` | Superó el límite de peticiones | "Espere un momento" |
| `503` | El servicio de IA no está configurado, no responde o se agotó la cuota | **Solo afecta a `/reportes/interpretar`.** Ofrece elegir un reporte del catálogo |

> El `422` es el más útil de todos: cuando alguien escribe un nombre ambiguo, el backend
> devuelve los candidatos en el mensaje. Píntalo íntegro en vez de un genérico.

**Los mensajes vienen saneados** (sin `<`, `>` ni comillas), pero eso no te exime: píntalos
siempre como texto, nunca con `innerHTML` / `dangerouslySetInnerHTML`.

---

## 11. Ejemplo completo

```js
const API = 'http://localhost:4000';

const cabeceras = (token) => ({ Authorization: `Bearer ${token}` });

/** 1. Menú: los reportes que este usuario puede ejecutar. */
async function cargarCatalogo(token) {
  const r = await fetch(`${API}/reportes`, { headers: cabeceras(token) });
  if (!r.ok) throw await r.json();
  const { datos, interpretacionDisponible } = await r.json();

  // Agrupado para el menú lateral.
  const porCategoria = datos.reduce((acc, reporte) => {
    (acc[reporte.categoria] ??= []).push(reporte);
    return acc;
  }, {});

  return { porCategoria, datos, interpretacionDisponible };
}

/** 2. Ejecutar y pintar la tabla. */
async function ejecutar(clave, definicion, valores, token) {
  const query = construirQuery(definicion, valores);
  const r = await fetch(`${API}/reportes/${clave}?${query}`, { headers: cabeceras(token) });
  if (!r.ok) throw await r.json();
  return r.json();
}

/** 3. Descargar. Ver §8: hace falta fetch + blob por el header de autorización. */
async function descargar(clave, formato, definicion, valores, token) {
  const query = construirQuery(definicion, valores);
  return descargarReporte(clave, formato, query, token);
}

/** 4. Petición escrita. Solo si interpretacionDisponible es true. */
async function interpretar(instruccion, token) {
  const r = await fetch(`${API}/reportes/interpretar`, {
    method: 'POST',
    headers: { ...cabeceras(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruccion }),
  });
  if (!r.ok) throw await r.json();
  return r.json();
}
```

### Componente de tabla (React, de referencia)

```jsx
function TablaReporte({ reporte }) {
  return (
    <div>
      <h1>{reporte.titulo}</h1>
      {reporte.subtitulo && <p className="subtitulo">{reporte.subtitulo}</p>}
      {reporte.periodo && <p className="periodo">Período: {reporte.periodo.etiqueta}</p>}

      {reporte.filtrosAplicados.length > 0 && (
        <div className="chips">
          {reporte.filtrosAplicados.map((f) => (
            <span key={f.etiqueta}>{f.etiqueta}: {f.valor}</span>
          ))}
        </div>
      )}

      <div className="kpis">
        {reporte.kpis.map((kpi) => (
          <div key={kpi.etiqueta} className="kpi">
            <small>{kpi.etiqueta}</small>
            {/* Ya viene formateado: no reformatear. */}
            <strong>{kpi.valor}</strong>
            {kpi.detalle && <em>{kpi.detalle}</em>}
          </div>
        ))}
      </div>

      {reporte.truncado && <div className="aviso">{reporte.notas[0]}</div>}

      {reporte.secciones.map((seccion, i) => (
        <section key={i}>
          {seccion.titulo && <h2>{seccion.titulo}</h2>}

          {/* orientacion 'horizontal' avisa de que la tabla es ancha. */}
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  {seccion.columnas.map((col) => (
                    <th key={col.clave} style={{ textAlign: alineacion(col) }}>
                      {col.titulo}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {seccion.filas.length === 0 && (
                  <tr>
                    <td colSpan={seccion.columnas.length}>
                      Sin datos para los filtros aplicados.
                    </td>
                  </tr>
                )}
                {seccion.filas.map((fila, f) => (
                  <tr key={f}>
                    {seccion.columnas.map((col) => (
                      <td key={col.clave} style={{ textAlign: alineacion(col) }}>
                        {formatearCelda(fila[col.clave], col)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {seccion.totales && (
                <tfoot>
                  <tr>
                    {seccion.columnas.map((col, i) => (
                      <td key={col.clave} style={{ textAlign: alineacion(col) }}>
                        {seccion.totales[col.clave] !== undefined
                          ? formatearCelda(seccion.totales[col.clave], col)
                          : i === 0 ? 'TOTAL' : ''}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
      ))}

      {reporte.notas?.length > 0 && (
        <ul className="notas">
          {reporte.notas.map((nota, i) => <li key={i}>{nota}</li>)}
        </ul>
      )}

      <footer>
        Generado por {reporte.generadoPor} el{' '}
        {reporte.generadoEn.slice(0, 16).replace('T', ' ')}
      </footer>
    </div>
  );
}
```

---

## 12. Checklist de integración

- [ ] El menú se construye desde `GET /reportes`, **no** con una lista escrita a mano.
- [ ] Agrupado por `categoria`.
- [ ] La caja de texto de la vía a medida solo aparece si `interpretacionDisponible` es `true`.
- [ ] El formulario usa `filtro.parametros` para armar la query, no `filtro.clave`
      (si no, el rango de fechas manda `periodo=` y da `400`).
- [ ] No se envían parámetros que el reporte no declara.
- [ ] La tabla recorre `seccion.columnas`; **ninguna clave de columna está escrita a mano**.
- [ ] Se recorren **todas** las `secciones`, no solo la primera.
- [ ] `porcentaje` se multiplica por 100 al mostrar.
- [ ] `null` se pinta como `—`.
- [ ] Los `kpis` se pintan tal cual, sin reformatear.
- [ ] Los totales salen de `seccion.totales`, sin recalcular en el cliente.
- [ ] La descarga usa `fetch` + `blob`, **no** `window.open` ni `<a href>`.
- [ ] Se llama a `URL.revokeObjectURL` después de descargar.
- [ ] El `422` se muestra íntegro (trae los candidatos cuando un nombre es ambiguo).
- [ ] El `503` solo bloquea la vía a medida; los reportes del catálogo siguen ofreciéndose.
- [ ] Los mensajes de error se pintan como texto, nunca con `innerHTML`.

---

## Referencia rápida

```
GET  /reportes                       Reportes.Ver        catálogo filtrado por permisos
GET  /reportes/:clave                Reportes.Ver        JSON            ← sin IA
GET  /reportes/:clave/pdf            Reportes.Exportar   PDF, inline     ← sin IA
GET  /reportes/:clave/excel          Reportes.Exportar   XLSX, attachment← sin IA
POST /reportes/interpretar           Reportes.Ver        traduce una frase (única ruta con IA)
```


