// Portable test lifecycle; fixtures contain synthetic data and bind loopback only.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
const mode = process.argv[2] ?? "browser";
if (!["browser", "oidc"].includes(mode)) throw Error("Use browser or oidc");
const port = mode === "oidc" ? 4390 : 4379;
async function ready(url, alive = () => true) {
  for (let i = 0; i < 90; i++) {
    if (!alive()) throw Error("Fixture exited before readiness");
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {}
    await delay(500);
  }
  throw Error("Readiness timeout: " + url);
}
if (mode === "oidc")
  await ready(
    "http://localhost:4391/realms/anymail/.well-known/openid-configuration",
  );
const server = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    `tests/${mode === "oidc" ? "oidc" : "browser"}-server.ts`,
  ],
  { stdio: "inherit" },
);
let python;
let serverError;
server.on("error", (e) => {
  serverError = e;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    python?.kill(signal);
    server.kill(signal);
  });
try {
  await ready(
    `http://127.0.0.1:${port}/healthz`,
    () =>
      !serverError && server.exitCode === null && server.signalCode === null,
  );
  python = spawn(
    process.env.BROWSER_PYTHON || "python3",
    [`tests/${mode}.py`],
    { stdio: "inherit" },
  );
  const [code] = await once(python, "exit");
  process.exitCode = code ?? 1;
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
