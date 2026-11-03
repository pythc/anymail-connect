// Generates a local-only synthetic realm using the production deployment template.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const values = {
  BASE_URL: "http://localhost:4390",
  OIDC_CLIENT_SECRET: "local-oidc-lab-only",
  ANYMAIL_TENANT_ID: "lab-personal-and-enterprise",
  CHATGPT_REDIRECT_URI: "http://localhost:4390/test-client-callback",
};
const realm = JSON.parse(
  readFileSync("deploy/keycloak-realm.template.json", "utf8").replace(
    /\$\{([A-Z_]+)\}/g,
    (_, key) => JSON.stringify(values[key]).slice(1, -1),
  ),
);
realm.users = [
  {
    username: "lab-user",
    enabled: true,
    email: "lab@example.invalid",
    emailVerified: true,
    firstName: "Lab",
    lastName: "User",
    credentials: [
      { type: "password", value: "local-keycloak-lab-only", temporary: false },
    ],
  },
];
mkdirSync(".artifacts/oidc", { recursive: true, mode: 0o700 });
writeFileSync(".artifacts/oidc/anymail-realm.json", JSON.stringify(realm), {
  mode: 0o600,
});
