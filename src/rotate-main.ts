import { runtime } from "./runtime.js";
import { rotateKeys } from "./maintenance.js";
const r = await runtime();
try {
  console.info(
    JSON.stringify(
      await rotateKeys(r.service, process.argv.includes("--apply")),
    ),
  );
} finally {
  await r.db.close();
}
