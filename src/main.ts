import { runtime } from "./runtime.js";
import { authentication } from "./auth.js";
import { app } from "./app.js";
const r = await runtime();
try {
  const auth = await authentication(r.config),
    server = await app(r.service, r.config, auth.verify, auth.settings);
  await server.listen({ port: r.config.PORT, host: "0.0.0.0" });
  console.info("AnyMail HTTP server ready");
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      await server.close();
      await r.db.close();
    });
} catch {
  console.error(
    "Startup failed: verify database, encryption key, OIDC discovery and configuration. Credentials are not logged.",
  );
  await r.db.close();
  process.exitCode = 1;
}
