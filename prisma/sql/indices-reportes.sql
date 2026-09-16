-- Índices de cobertura para el módulo de Reportes.
--
-- POR QUÉ NO ESTÁN EN schema.prisma
-- ---------------------------------
-- Prisma 6 sabe declarar un índice sobre unas columnas, pero no sabe declarar las
-- columnas *incluidas* (`INCLUDE`), que es justo lo que hace falta aquí.
--
-- Los desgloses de venta filtran por `fechaCreacion` y a continuación leen
-- `idAtraccion`, `idUsuario`, `montoTotal` y compañía. Con el índice que ya existe
-- sobre `fechaCreacion` a secas, SQL Server encuentra las filas por el índice y
-- después va a buscar cada una a la tabla: un *key lookup* por fila. En un mes de
-- ventas eso son miles de saltos que el motor evita a veces prefiriendo un recorrido
-- completo de la tabla, que es peor todavía.
--
-- Con las columnas incluidas, el índice se basta solo: el reporte se resuelve sin
-- tocar la tabla.
--
-- Los demás índices que necesitaba el módulo (Bitacora.fecha, TicketPago.idTicket,
-- CierreCaja.fechaCierre) sí se pueden expresar en Prisma y están declarados en
-- schema.prisma. Aquí queda únicamente lo que Prisma no alcanza.
--
-- CÓMO SE APLICA
-- --------------
--   npx prisma db push
--   npx ts-node prisma/aplicar-indices-reportes.ts
--
-- El script es idempotente y hay que volver a correrlo DESPUÉS DE CADA `db push`:
-- Prisma no recrea lo que no conoce. Perderlos no rompe nada visible — los reportes
-- siguen dando las mismas cifras, solo que tardan mucho más.

-- Cubre los ocho reportes de ventas: filtro por fecha + las columnas que agregan.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Ticket_Fecha_Reportes' AND object_id = OBJECT_ID('dbo.Ticket'))
    CREATE INDEX IX_Ticket_Fecha_Reportes
        ON dbo.Ticket (anulado, fechaCreacion)
        INCLUDE (idAtraccion, idUsuario, idOrigen, idPais, idGuia, idTipoRecorrido,
                 idAperturaCaja, montoTotal, cantidadPersonas);

-- Cubre el arqueo y el desglose por forma de pago: se filtra por ticket y estado, y
-- se suma el monto.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TicketPago_Reportes' AND object_id = OBJECT_ID('dbo.TicketPago'))
    CREATE INDEX IX_TicketPago_Reportes
        ON dbo.TicketPago (anulado, estadoPago, idTicket)
        INCLUDE (idOpcionPago, monto);

-- Cubre el resumen de donaciones por día y por usuario.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Donacion_Fecha_Reportes' AND object_id = OBJECT_ID('dbo.Donacion'))
    CREATE INDEX IX_Donacion_Fecha_Reportes
        ON dbo.Donacion (anulado, fechaCreacion)
        INCLUDE (idUsuario, idAperturaCaja, monto);
