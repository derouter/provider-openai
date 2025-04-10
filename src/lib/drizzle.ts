import { Deferred } from "@derouter/rpc/util";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import * as schema from "./drizzle/schema.js";
import { Migration, migrate as migrate_ } from "./drizzle/scripts/migrate.js";
import { pick } from "./util.js";

export type Transaction = Parameters<Parameters<typeof d.db.transaction>[0]>[0];
const sqlite = new DatabaseSync(config.database_url);

/**
 * ADHOC: A `node:sqlite` Drizzle wrapper until https://github.com/drizzle-team/drizzle-orm/pull/4346 is merged.
 * @see https://github.com/drizzle-team/drizzle-orm/pull/4346#issuecomment-2766792806
 */
const db = drizzle<typeof schema>(
  async (sql, params, method) => {
    // console.debug({ sql, params, method });
    let stmt = sqlite.prepare(sql);

    switch (method) {
      case "all": {
        const rows = stmt.all(...params);
        // console.debug({ rows });

        return {
          rows: rows.map((row) => Object.values(row as any)),
        };
      }

      case "get": {
        const row = stmt.get(...params);
        // console.debug({ row });

        if (row) {
          return { rows: Object.values(row as any) };
        } else {
          return { rows: [] };
        }
      }

      case "run":
      case "values":
        stmt.run(...params);
        return { rows: [] };
    }
  },

  // Pass the schema to the drizzle instance
  { schema }
);

export const d = {
  db,
  ...pick(schema, ["jobs"]),
};

import Migration000 from "./drizzle/migrations/000_createJobs.js";

export const dbMigrated = new Deferred<true>();

async function migrate(
  toIndex?: number,
  migrationsTable = "meta",
  migrationsKey = "current_migration_index"
) {
  const migrations: Migration[] = [new Migration000()];

  return migrate_(
    migrations,
    migrationsTable,
    migrationsKey,
    toIndex ?? migrations.length - 1
  );
}

migrate().then(() => dbMigrated.resolve(true));
