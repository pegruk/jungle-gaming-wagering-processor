import { Database } from "../../src/infra/database/database";
import { FinanceService } from "../../src/application/finance.service";
import { createTestDatabase } from "./database";

export async function createTestApplication() {
  const database = await createTestDatabase();
  const db = await Database.connect(database.connectionString, database.schema);
  const service = new FinanceService(db);
  return { ...database, db, service, async close() { await db.close(); await database.close(); } };
}
