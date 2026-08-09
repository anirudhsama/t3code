import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "skill_overrides_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN skill_overrides_json TEXT NOT NULL DEFAULT '{}'
    `;
  }
  if (!columns.some((column) => column.name === "mcp_overrides_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN mcp_overrides_json TEXT NOT NULL DEFAULT '{}'
    `;
  }
  if (!columns.some((column) => column.name === "extension_overrides_revision")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN extension_overrides_revision INTEGER NOT NULL DEFAULT 0
    `;
  }
});
