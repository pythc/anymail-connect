import { randomBytes } from "node:crypto";
console.log("ENCRYPTION_KEY=" + randomBytes(32).toString("base64"));
console.log("POSTGRES_PASSWORD=" + randomBytes(24).toString("hex"));
console.log("OIDC_CLIENT_SECRET=" + randomBytes(32).toString("hex"));
