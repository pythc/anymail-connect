import { mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
mkdirSync(".test-certs", { recursive: true, mode: 0o700 });
if (!existsSync(".test-certs/ca.crt"))
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
