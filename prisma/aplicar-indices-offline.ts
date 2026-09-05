/**
 * Crea los índices únicos filtrados que Prisma no puede declarar.
 *
 * Hay que correrlo **después de cada `prisma db push`**: Prisma no recrea lo que
 * no conoce. Perderlos no rompe nada visible — simplemente desaparece la garantía
 * de idempotencia y los reintentos de la cola offline empiezan a duplicar tickets
 * en silencio. Ver el encabezado de `prisma/sql/indices-offline.sql`.
 *
 * Idempotente. Uso: npx ts-node prisma/aplicar-indices-offline.ts
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

const INDICES = [
  { nombre: 'UX_Ticket_idLocal', tabla: 'Ticket' },
  { nombre: 'UX_FolioReservado_idTicket', tabla: 'FolioReservado' },
];

async function main() {
  const sql = readFileSync(join(__dirname, 'sql', 'indices-offline.sql'), 'utf8');

  // Cada `CREATE INDEX` va en su propio lote: SQL Server no acepta varios
  // en la misma ejecución cuando llevan `IF NOT EXISTS` delante.
  const sentencias = sql
    .split(/\r?\n/)
    .filter((linea) => !linea.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sentencia of sentencias) {
    await prisma.$executeRawUnsafe(sentencia);
  }

  for (const { nombre, tabla } of INDICES) {
    const [fila]: any = await prisma.$queryRawUnsafe(
      `SELECT i.name, i.is_unique, i.has_filter, i.filter_definition
         FROM sys.indexes i
        WHERE i.name = '${nombre}' AND i.object_id = OBJECT_ID('dbo.${tabla}')`,
    );

    if (!fila) {
      throw new Error(`El índice ${nombre} no quedó creado sobre ${tabla}.`);
    }

    if (!fila.is_unique || !fila.has_filter) {
      throw new Error(
        `El índice ${nombre} existe pero no es único filtrado (unique=${fila.is_unique}, filtered=${fila.has_filter}).`,
      );
    }

    console.log(`${nombre} sobre ${tabla}: único filtrado ${fila.filter_definition}`);
  }

  console.log('\nÍndices en su lugar.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
