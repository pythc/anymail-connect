import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

const base = "http://localhost:4480";
const issuer = "http://localhost:4481/realms/anymail-demo";
const callback = "http://127.0.0.1:4482/callback";
const dir = resolve(".artifacts/demo");
const root = fileURLToPath(new URL("../", import.meta.url));
const secret = () => randomBytes(32).toString("hex");
const save = (name, value, mode = 0o600) =>
  writeFile(resolve(dir, name), value, { mode, flag: "wx" });

if (process.argv[2] === "init") {
  await mkdir(resolve(".artifacts"), { recursive: true, mode: 0o700 });
  // Exclusive creation prevents silently replacing keys for an existing database.
  await mkdir(dir, { mode: 0o700 });
  if (/[\r\n$]/.test(dir)) throw Error("Unsupported configuration path");
  const dbPassword = secret(),
    clientSecret = secret(),
    password = secret(),
    values = {
      BASE_URL: base,
      OIDC_CLIENT_SECRET: clientSecret,
      ANYMAIL_TENANT_ID: "synthetic-demo",
      CHATGPT_REDIRECT_URI: callback,
    },
    realm = JSON.parse(
      (
        await readFile(
          resolve(root, "deploy/keycloak-realm.template.json"),
          "utf8",
        )
      ).replace(/\$\{([A-Z_]+)\}/g, (_, key) =>
        JSON.stringify(values[key]).slice(1, -1),
      ),
    );
  realm.realm = "anymail-demo";
  realm.resetPasswordAllowed = false;
  realm.users = [
    {
      id: "a5a8c029-96a0-4ea7-9449-50178ef90ed1",
      username: "demo",
      enabled: true,
      email: "demo@example.test",
      emailVerified: true,
      firstName: "Synthetic",
      lastName: "Demo",
      credentials: [{ type: "password", value: password, temporary: false }],
    },
  ];
  const client = realm.clients.find((c) => c.clientId === "anymail-chatgpt");
  client.clientId = "anymail-demo-cli";
  const version = JSON.parse(
    await readFile(resolve(root, "package.json")),
  ).version;
  const image =
    process.env.ANYMAIL_IMAGE || `ghcr.io/pythc/anymail-connect:${version}`;
  if (!/^[a-zA-Z0-9@/:._-]+$/.test(image))
    throw Error("Invalid image reference");
  await save(
    "compose.env",
    `DEMO_DIR=${JSON.stringify(dir)}\nPOSTGRES_PASSWORD=${dbPassword}\nANYMAIL_IMAGE=${image}\n`,
  );
  await save(
    "app.env",
    [
      "NODE_ENV=development",
      "PORT=4480",
      `BASE_URL=${base}`,
      `DATABASE_URL=postgresql://anymail:${dbPassword}@db:5432/anymail_demo`,
      `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
      `OIDC_ISSUER=${issuer}`,
      `OIDC_AUDIENCE=${base}/mcp`,
      "OIDC_CLIENT_ID=anymail-web",
      `OIDC_CLIENT_SECRET=${clientSecret}`,
      "ALLOWED_CLIENT_IDS=anymail-web,anymail-demo-cli",
      "OIDC_INTROSPECTION=true",
    ].join("\n") + "\n",
  );
  // Keycloak's non-root user needs the mounted file readable. Its host directory is 0700.
  await save("realm.json", JSON.stringify(realm, null, 2), 0o644);
  await save("login.txt", `Username: demo\nPassword: ${password}\n`);
  console.log(
    `Private demo configuration: ${dir}\nLogin credentials: ${dir}/login.txt`,
  );
  console.log(
    "docker compose --env-file .artifacts/demo/compose.env -f examples/demo/compose.yaml up -d --wait",
  );
} else if (process.argv[2] === "walk") {
  const state = secret(),
    verifier = secret();
  let accept, reject;
  const code = new Promise((yes, no) => {
    accept = yes;
    reject = no;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, callback);
    if (
      url.pathname !== "/callback" ||
      url.searchParams.get("state") !== state ||
      !url.searchParams.get("code")
    ) {
      res.writeHead(400).end("Invalid authorization response");
      return;
    }
    res
      .writeHead(200, {
        "content-type": "text/plain",
        "cache-control": "no-store",
      })
      .end("Signed in. Return to the terminal for the synthetic workflow.");
    accept(url.searchParams.get("code"));
  });
  const timer = globalThis.setTimeout(
    () => reject(Error("Login timed out")),
    180_000,
  );
  try {
    await new Promise((yes, no) => {
      server.once("error", no);
      server.listen(4482, "127.0.0.1", yes);
    });
    const url = new URL(issuer + "/protocol/openid-connect/auth");
    url.search = new URLSearchParams({
      client_id: "anymail-demo-cli",
      redirect_uri: callback,
      response_type: "code",
      scope: "openid mail.read mail.write mail.send",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    console.log(`Sign in as demo: ${url.href}`);
    const response = await fetch(issuer + "/protocol/openid-connect/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "anymail-demo-cli",
        code: await code,
        redirect_uri: callback,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw Error("Token exchange failed");
    const { access_token: token } = await response.json();
    server.close();
    globalThis.clearTimeout(timer);
    const call = async (tool, input) => {
      const r = await fetch(`${base}/api/call/${tool}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw Error(`${tool}: HTTP ${r.status}`);
      return r.json();
    };
    const [account] = await call("accounts_list", {});
    const page = await call("messages_search", {
      account_id: account.id,
      search: { query: "invoice" },
    });
    const message = await call("messages_get", {
      account_id: account.id,
      message_id: page.items[0].id,
    });
    console.log(`Search/read: ${message.subject} (synthetic)`);
    const draft = await call("drafts_create", {
      account_id: account.id,
      content: {
        to: ["recipient@example.test"],
        cc: [],
        bcc: [],
        subject: "Synthetic demo reply",
        text: "Approved content is submitted to a simulation. No mail is delivered.",
        attachmentIds: [],
        references: [],
      },
    });
    const operation = await call("drafts_prepare_send", {
      account_id: account.id,
      draft_id: draft.id,
      revision: draft.revision,
      idempotency_key: `demo:${secret()}`,
    });
    console.log(`Sign in to the browser session: ${base}/auth/login`);
    console.log(`Review and approve: ${operation.approval_url}`);
    for (let i = 0; i < 120; i++) {
      const result = await call("operations_get", {
        operation_id: operation.id,
      });
      if (result.state === "provider_accepted") {
        console.log(
          "Completed: synthetic provider_accepted; no real mail delivered.",
        );
        process.exitCode = 0;
        break;
      }
      if (["failed", "unknown", "cancelled"].includes(result.state))
        throw Error(`Stopped: ${result.state}`);
      if (i === 119)
        throw Error(
          "Approval timed out; inspect the persisted operation before starting another walk",
        );
      await setTimeout(2000);
    }
  } finally {
    globalThis.clearTimeout(timer);
    server.close();
  }
} else {
  throw Error("Usage: node scripts/demo.mjs init|walk");
}
