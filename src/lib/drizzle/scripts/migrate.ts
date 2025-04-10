import { sql } from "drizzle-orm";
import assert from "node:assert";
import { d, type Transaction } from "../../drizzle.js";

// TODO: Implement executeBatch call to allow multiple statements.
export interface Migration {
  name: string;
  up: (tx: Transaction) => Promise<void>;
  down: (tx: Transaction) => Promise<void>;
}

/**
 * Run migrations.
 *
 * @param migrations - The migrations array to run.
 * @param kvTable - The key-value table name to store the current migration index.
 * Will be created if it doesn't exist yet.
 * @param currentMigrationKey - The key to store the current migration index.
 * @param toIndex - The target migration index.
 *
 * @returns The number of applied migrations.
 *
 * @example
 * migrate() // Migrate to the latest migration.
 * migrate(0) // Migrate to the first migration.
 * // migrate(-1) // Error! If you want to drop all tables,
 *                // delete the database file instead.
 */
export async function migrate(
  migrations: Migration[],
  kvTable: string,
  currentMigrationKey: string,
  toIndex: number
): Promise<number> {
  console.debug(`migrate(toIndex: ${toIndex})`);

  assert(Number.isInteger(toIndex), "toIndex must be an integer");
  assert(toIndex >= 0, "toIndex must be >= 0");
  assert(toIndex < migrations.length, `toIndex must be < ${migrations.length}`);

  let migrationsRun = 0;
  await d.db.transaction(async (tx) => {
    const to = migrations.at(toIndex);
    if (!to) throw new Error(`Migration not found at index ${toIndex}`);

    console.debug("Create KV table if it doesn't exist yet...");
    await tx.run(
      sql.raw(`
        CREATE TABLE IF NOT EXISTS "${kvTable}" (
          "key" VARCHAR(255) PRIMARY KEY,
          "value" TEXT
        );
    `)
    );

    console.debug("Get current migration index...");
    const queryResult = await tx.get<number[] | undefined>(
      sql.raw(`
        SELECT
          cast("value" AS INTEGER) AS "index"
        FROM
          "${kvTable}"
        WHERE
          "key" = '${currentMigrationKey}'
    `)
    );
    let fromIndex = queryResult?.at(0);

    if (fromIndex === toIndex) {
      console.log(`Already at index ${toIndex}, nothing to do.`);
      return;
    }

    fromIndex = fromIndex ?? -1;
    const isUp = toIndex >= fromIndex;

    console.log(
      `Will migrate ${isUp ? "up" : "down"} from ${
        fromIndex === -1 ? "scratch" : migrations[fromIndex].name
      } to ${to.name}...`
    );

    for (const migration of isUp
      ? migrations.slice(fromIndex + 1, toIndex + 1)
      : migrations.slice(toIndex + 1, fromIndex + 1).reverse()) {
      console.debug(`Migrate ${isUp ? "up" : "down"} ${migration.name}...`);

      if (isUp) {
        await migration.up(tx);
      } else {
        await migration.down(tx);
      }

      migrationsRun++;
    }

    await tx.run(
      sql.raw(`
        INSERT INTO
          "${kvTable}" ("key", "value")
        VALUES
          (
            '${currentMigrationKey}',
            cast(${toIndex} AS TEXT)
          )
        ON CONFLICT ("key") DO
        UPDATE
        SET
          "value" = cast(${toIndex} AS TEXT)
    `)
    );
  });

  return migrationsRun;
}
