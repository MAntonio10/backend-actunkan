-- Índices únicos filtrados para la venta offline.
--
-- POR QUÉ NO ESTÁN EN schema.prisma
-- ---------------------------------
-- En SQL Server un índice único admite UNA SOLA fila con NULL. Un `@unique` de
-- Prisma sobre una columna anulable rompe la segunda fila que la deje en NULL:
--
--   Cannot insert duplicate key row in object 'dbo.Ticket' with unique index
--   'UX_Ticket_idLocal'. The duplicate key value is (<NULL>).   -- error 2601
--
-- Las dos columnas de abajo son anulables por diseño:
--   * Ticket.idLocal          -> null en TODAS las ventas online.
--   * FolioReservado.idTicket -> null mientras el folio está en RESERVADO.
--
-- Un índice filtrado exige unicidad solo entre las filas con valor, que es lo
-- que se necesita. Prisma no sabe expresarlo, así que se aplica aparte.
--
-- CÓMO SE APLICA
-- --------------
--   npx prisma db push
--   npx ts-node prisma/aplicar-indices-offline.ts
--
-- El script es idempotente y hay que volver a correrlo DESPUÉS DE CADA `db push`:
-- Prisma no recrea lo que no conoce, y perder estos índices no rompe nada de
-- forma visible — simplemente deja de haber garantía de idempotencia y los
-- reintentos de la cola empiezan a duplicar tickets en silencio.

-- Idempotencia de la subida de ventas offline: dos intentos con el mismo
-- `idLocal` no pueden crear dos tickets.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Ticket_idLocal' AND object_id = OBJECT_ID('dbo.Ticket'))
    CREATE UNIQUE INDEX UX_Ticket_idLocal
        ON dbo.Ticket (idLocal)
        WHERE idLocal IS NOT NULL;

-- Un folio reservado respalda como máximo una venta.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_FolioReservado_idTicket' AND object_id = OBJECT_ID('dbo.FolioReservado'))
    CREATE UNIQUE INDEX UX_FolioReservado_idTicket
        ON dbo.FolioReservado (idTicket)
        WHERE idTicket IS NOT NULL;
