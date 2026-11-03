import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
mkdirSync(".test-certs", { recursive: true, mode: 0o700 });
let fresh = false;
try {
  fresh =
    existsSync(".test-certs/server.key") &&
    Date.parse(
      new X509Certificate(readFileSync(".test-certs/ca.crt")).validTo,
    ) >
      Date.now() + 3600_000;
} catch {}
if (!fresh)
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      ".test-certs/server.key",
      "-out",
      ".test-certs/ca.crt",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
