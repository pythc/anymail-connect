import { postgres, migrate } from "./db.js";
const db = postgres(process.env.DATABASE_URL || "");
try {
  await migrate(db);
  console.info("Schema v2 ready");
} finally {
  await db.close();
}
