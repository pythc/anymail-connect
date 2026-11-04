// Synthetic mailbox for the isolated demo; no network or real mail delivery.
import {
  baseCapabilities,
  MailError,
  type MailProvider,
  type Message,
  type Search,
} from "../../src/domain.js";

const messages: Message[] = [
  {
    id: "welcome",
    from: "maintainer@example.test",
    to: ["demo@example.test"],
    subject: "Welcome to the synthetic AnyMail mailbox",
    text: "Search, read and prepare a draft. Approval uses the normal OIDC browser session. Submission is simulated; no email leaves this demo.",
    date: "2026-11-04T00:00:00Z",
    read: false,
    folder: "INBOX",
    attachments: [],
    warnings: ["SYNTHETIC_DEMO_NO_PROVIDER_PROTOCOL"],
  },
  {
    id: "invoice",
    from: "accounts@example.test",
    to: ["demo@example.test"],
    subject: "Invoice demo-001",
    text: "This fictional invoice is for a synthetic project. No payment is due.",
    date: "2026-11-03T00:00:00Z",
    read: true,
    folder: "INBOX",
    attachments: [],
    warnings: ["SYNTHETIC_DEMO_NO_PROVIDER_PROTOCOL"],
  },
];

export class DemoProvider implements MailProvider {
  capabilities = {
    ...baseCapabilities,
    read: "emulated" as const,
    folders: "emulated" as const,
    send: "emulated" as const,
  };
  async verify() {
    return { email: "demo@example.test" };
  }
  async search(input: Search) {
    // Deliberately a small text-search subset, not a provider query language.
    const terms = [input.query, input.from, input.subject].filter(Boolean);
    const items = messages.filter(
      (m) =>
        terms.every((term) =>
          `${m.subject} ${m.text} ${m.from}`
            .toLowerCase()
            .includes(term!.toLowerCase()),
        ) &&
        (input.unread === undefined || input.unread === !m.read) &&
        (!input.folder || input.folder === m.folder) &&
        (!input.after || m.date.slice(0, 10) >= input.after) &&
        (!input.before || m.date.slice(0, 10) < input.before),
    );
    return {
      items: structuredClone(items.slice(0, input.limit)),
      coverage: "synthetic-demo-text-subset; no provider protocol",
    };
  }
  async get(id: string) {
    const message = messages.find((m) => m.id === id);
    if (!message) throw new MailError("NOT_FOUND", 404);
    return structuredClone(message);
  }
  async attachment(): Promise<never> {
    throw new MailError("NOT_FOUND", 404);
  }
  async folders() {
    return [{ id: "INBOX", name: "Synthetic inbox" }];
  }
  async mutate(): Promise<never> {
    throw new MailError("UNSUPPORTED_CAPABILITY", 422);
  }
  async send(_draft: unknown, _attachments: unknown, intentId: string) {
    return {
      state: "provider_accepted" as const,
      providerId: "synthetic-no-delivery:" + intentId,
    };
  }
}
