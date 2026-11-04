// Narrow browser boundaries for mailbox OAuth and human send consent.
// Mailbox browsing and draft editing belong to the consuming MCP/API client.
export const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

export function document(title: string, body: string, script = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · AnyMail Connect</title><link rel="stylesheet" href="/browser.css"></head><body><main><header><a href="/connect">AnyMail Connect</a><span>Email infrastructure for MCP</span></header>${body}</main>${script ? `<script src="${script}" defer></script>` : ""}</body></html>`;
}

export const connectionPage = document(
  "Connect a mailbox",
  `<h1>Connect a mailbox</h1>
<p>This endpoint handles provider authorization. Use your MCP or HTTP client for email operations.</p>
<nav><a href="/auth/login">Sign in</a><button id="logout" type="button" disabled>Sign out</button></nav>
<p id="status" role="status" aria-live="polite">Sign in to authorize a mailbox.</p>
<form id="oauth"><fieldset id="authorization" disabled><legend>Provider authorization</legend>
<label>Provider<select name="provider"><option value="gmail">Gmail / Google Workspace</option><option value="graph">Outlook / Microsoft 365</option></select></label>
<label>Delegated Microsoft shared mailbox (optional)<input name="mailbox" type="email" autocomplete="off"></label>
<label><input name="writable" type="checkbox"> Allow mail and contact changes</label>
<label><input name="sendEnabled" type="checkbox"> Allow sending (also requires changes)</label>
<p>Read-only by default. The provider displays the requested permissions before you consent. Credentials are encrypted on this server. Sending requires a separate approval of the exact message.</p>
<button id="authorize" type="submit">Continue to provider</button></fieldset></form>
<p>IMAP/SMTP, JMAP and administrator-approved EWS connections use <code>POST /api/accounts/connect</code>. No mailbox password is entered on this page.</p>`,
  "/connect.js",
);

export const connectionScript = `"use strict";
const form = document.getElementById('oauth');
const fields = document.getElementById('authorization');
const status = document.getElementById('status');
const logout = document.getElementById('logout');
let csrf = '';
async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Request failed');
  return result;
}
request('/api/me').then(me => {
  csrf = me.csrf;
  fields.disabled = false;
  logout.disabled = false;
  status.textContent = 'Signed in. Choose a provider and review the requested access.';
}).catch(error => { status.textContent = error.message === 'AUTH_REQUIRED' ? 'Sign in to authorize a mailbox.' : error.message; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(form);
  const writable = data.has('writable');
  const sendEnabled = data.has('sendEnabled');
  const provider = String(data.get('provider'));
  const mailbox = String(data.get('mailbox') || '').trim();
  if (sendEnabled && !writable) { status.textContent = 'Sending requires mail changes to be enabled.'; return; }
  if (mailbox && provider !== 'graph') { status.textContent = 'The shared mailbox field is only for Microsoft delegated access.'; return; }
  fields.disabled = true;
  try {
    const result = await request('/api/oauth/start', { provider, writable, sendEnabled, ...(mailbox ? {mailbox} : {}) });
    window.location.assign(result.url);
  } catch(error) { status.textContent = error.message; }
  finally { fields.disabled = false; }
});
logout.addEventListener('click', async () => {
  try { await request('/api/logout', {}); window.location.assign('/connect'); }
  catch(error) { status.textContent = error.message; }
});`;

export const browserStyle = `:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}body{margin:0}main{max-width:48rem;margin:4rem auto;padding:0 1.5rem}header{display:flex;flex-wrap:wrap;gap:1rem;justify-content:space-between;border-bottom:1px solid #8886;padding-bottom:1rem;margin-bottom:3rem}header span{opacity:.65}h1{line-height:1.2;letter-spacing:-.035em}a{color:inherit;text-underline-offset:.2em}nav{display:flex;align-items:center;gap:1.5rem}fieldset{border:1px solid #8886;margin:2rem 0;padding:1.5rem}label{display:block;margin:1rem 0}input[type=email],select{display:block;box-sizing:border-box;width:100%;padding:.6rem;margin-top:.35rem;font:inherit}button{font:inherit;padding:.5rem 1rem;cursor:pointer}button:disabled{cursor:default}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;border:1px solid #8886}li,code,p{overflow-wrap:anywhere}:focus-visible{outline:2px solid #c34e31;outline-offset:4px}@media(max-width:36rem){main{margin:2rem auto}fieldset{padding:1rem}}`;

export function approvalPage(
  operation: import("./service.js").Operation,
  csrf: string,
) {
  const manifest = (operation.attachments ?? [])
    .map(
      (attachment) =>
        `<li><a href="/api/uploads/${encodeURIComponent(operation.accountId)}/${encodeURIComponent(attachment.id)}">${escape(attachment.name)}</a> · ${escape(attachment.type)} · ${attachment.size} bytes<br>SHA-256: ${escape(attachment.sha256)}</li>`,
    )
    .join("");
  return document(
    "Approve email submission",
    `<h1>Approve email submission</h1><p>Sending mailbox: <strong>${escape(operation.sender ?? "Legacy operation; prepare again")}</strong></p><p>Account ID: ${escape(operation.accountId)}</p><p>Requesting client: ${escape(operation.client)} · State: ${escape(operation.state)} · Scheduled time: ${escape(operation.dueAt)}</p><p>Review the sender, To, Cc, Bcc, body and attachments. Approval authorizes this exact content. A due operation may be submitted by the worker immediately. Submitted mail cannot be reliably recalled.</p><h2>Attachments</h2><ul>${manifest || "<li>No attachments</li>"}</ul><h2>Message</h2><pre>${escape(JSON.stringify(operation.content, null, 2))}</pre><form method="post" action="/approve/${encodeURIComponent(operation.id)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="digest" value="${escape(operation.digest)}"><button type="submit">Approve this exact message</button></form>`,
  );
}
