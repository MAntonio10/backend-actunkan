/**
 * Crea los índices de cobertura del módulo de Reportes.
 *
 * Hay que correrlo **después de cada `prisma db push`**: Prisma no recrea lo que no
 * conoce, y no sabe declarar columnas incluidas (`INCLUDE`). Perderlos no cambia ninguna
 * cifra — los reportes siguen siendo correctos, solo que cada uno pasa de resolverse con
 * el índice a recorrer la tabla entera. Ver el encabezado de `prisma/sql/indices-reportes.sql`.
 *
 * Idempotente. Uso: npx ts-node prisma/aplicar-indices-reportes.ts
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

const INDICES = [
  { nombre: 'IX_Ticket_Fecha_Reportes', tabla: 'Ticket' },
  { nombre: 'IX_TicketPago_Reportes', tabla: 'TicketPago' },
  { nombre: 'IX_Donacion_Fecha_Reportes', tabla: 'Donacion' },
];

async function main() {
  const sql = readFileSync(join(__dirname, 'sql', 'indices-reportes.sql'), 'utf8');

  // Cada `CREATE INDEX` va en su propio lote: SQL Server no acepta varios en la misma
  // ejecución cuando llevan `IF NOT EXISTS` delante.
  const sentencias = sql
    .split(/\r?\n/)
    .filter((linea) => !linea.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*/)
    .map((sentencia) => sentencia.trim())
    .filter(Boolean);

  for (const sentencia of sentencias) {
    await prisma.$executeRawUnsafe(sentencia);
  }

  for (const { nombre, tabla } of INDICES) {
    const [fila]: any = await prisma.$queryRawUnsafe(
      `SELECT i.name,
              (SELECT COUNT(*) FROM sys.index_columns ic
                WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                  AND ic.is_included_column = 1) AS incluidas
         FROM sys.indexes i
        WHERE i.name = '${nombre}' AND i.object_id = OBJECT_ID('dbo.${tabla}')`,
    );

    if (!fila) {
      throw new Error(`El índice ${nombre} no quedó creado sobre ${tabla}.`);
    }

    // Sin columnas incluidas el índice existe pero no cubre nada, que es el escenario
    // que este script está para evitar.
    if (Number(fila.incluidas) === 0) {
      throw new Error(`El índice ${nombre} existe pero no lleva columnas incluidas.`);
    }

    console.log(`${nombre} sobre ${tabla}: ${fila.incluidas} columnas incluidas.`);
  }

  console.log('\nÍndices de reportes en su lugar.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
