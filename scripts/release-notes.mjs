import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const { IMAGE, DIGEST, GITHUB_SHA } = process.env;
if (!IMAGE || !/^sha256:[a-f0-9]{64}$/.test(DIGEST || "") || !GITHUB_SHA)
  throw Error("Release identity is incomplete");
console.log(`# AnyMail Connect ${version}

Development prerelease for self-hosted evaluation. Not production certification or universal Gmail/Outlook feature parity.

- Apache-2.0 license; English-first documentation with a Chinese README.
- Prebuilt Linux amd64/arm64 image with BuildKit SBOM/provenance and GitHub build attestation.
- Isolated synthetic mailbox demo with OIDC login and exact-message human approval; no real mail delivery.
- Adapter contribution guide, compatibility evidence and community templates.

## Install

\`\`\`sh
docker pull ${IMAGE}@${DIGEST}
gh attestation verify oci://${IMAGE}@${DIGEST} --repo pythc/anymail-connect
\`\`\`

Source revision: ${GITHUB_SHA}. Pin the digest above; version tags are convenience references, not an immutability guarantee. image.txt and SHA256SUMS identify the artifacts. BuildKit attestations are attached to the OCI image index.

See [Quickstart](https://github.com/pythc/anymail-connect/blob/v${version}/docs/quickstart.md) for the local demo and [release operations](https://github.com/pythc/anymail-connect/blob/v${version}/docs/releases.md) for verification, upgrades and recovery. No schema migration was added by this prerelease. Back up both databases, identity configuration and vault keys before replacing a real deployment. Preserve the previous digest and configuration; rollback after writes may require a matched database restore.

Gmail read-only behavior has limited private acceptance evidence; Microsoft real-account acceptance remains pending. The synthetic demo does not validate any provider protocol. No public remote MCP service or official MCP Registry listing is included.
`);
