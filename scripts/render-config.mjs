import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const values = [
  "BASE_URL",
  "OIDC_CLIENT_SECRET",
  "ANYMAIL_TENANT_ID",
  "CHATGPT_REDIRECT_URI",
];
for (const name of values)
  if (!process.env[name]) throw Error("Missing " + name);
const template = readFileSync("deploy/keycloak-realm.template.json", "utf8");
const rendered = template.replace(/\$\{([A-Z_]+)\}/g, (_, key) =>
  JSON.stringify(process.env[key]).slice(1, -1),
);
JSON.parse(rendered);
mkdirSync(".artifacts", { recursive: true, mode: 0o700 });
writeFileSync(".artifacts/anymail-realm.json", rendered, { mode: 0o600 });
console.log(
  "Rendered private .artifacts/anymail-realm.json; import into your Keycloak deployment.",
);
