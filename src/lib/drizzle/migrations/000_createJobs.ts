import { sql } from "drizzle-orm";
import { type Transaction } from "../../drizzle.js";
import { Migration } from "../scripts/migrate.js";

export default class implements Migration {
  name = "000_createJobs";

  async up(tx: Transaction) {
    await tx.run(sql`
      CREATE TABLE jobs (
        rowid INTEGER PRIMARY KEY,
        provider_peer_id TEXT NOT NULL,
        provider_job_id TEXT NOT NULL,
        input TEXT NOT NULL,
        streaming BOOLEAN NOT NULL,
        output TEXT,
        balance_delta TEXT,
        public_payload TEXT,
        openai_error TEXT,
        completed_at_sync INTEGER
      )
    `);

    await tx.run(sql`
      CREATE INDEX idx_jobs_main ON jobs (provider_peer_id, provider_job_id)
    `);
  }

  async down(tx: Transaction) {
    await tx.run(sql`
      DROP TABLE jobs
    `);
  }
}
