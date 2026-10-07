import { Database } from "../adapters/postgres/database.js";
import { configFromEnv } from "../config.js";

const config = configFromEnv();
const db = new Database(config.databaseUrl);
try {
  await db.migrate(config.schemaFile);
  console.log("Intrica schema 2 ready");
} finally {
  await db.close();
}
