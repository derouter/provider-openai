import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sortByKey } from "../../util.js";

export const jobs = sqliteTable(
  "jobs",
  sortByKey({
    rowid: integer("rowid").primaryKey(),
    providerPeerId: text("provider_peer_id").notNull(),
    providerJobId: text("provider_job_id").notNull(),
    input: text("input").notNull(),
    streaming: integer("streaming", { mode: "boolean" }).notNull(),
    output: text("output"),
    balanceDelta: text("balance_delta"),
    publicPayload: text("public_payload"),
    openaiError: text("openai_error"),
    completedAtSync: integer("completed_at_sync"),
  })
);
