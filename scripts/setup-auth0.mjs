#!/usr/bin/env node
// Creates (or finds, if they already exist) everything this demo needs on an
// Auth0 tenant, then writes the config to .env.
//
// Put these in .env (see .env.example), then run `npm run setup`:
//
//   AUTH0_DOMAIN=your-tenant.us.auth0.com
//   AUTH0_MGMT_CLIENT_ID=...
//   AUTH0_MGMT_CLIENT_SECRET=...
//
// (or AUTH0_MGMT_TOKEN, a short-lived token from Dashboard > Applications >
// APIs > Auth0 Management API > API Explorer, instead of the two MGMT_ values).
//
// The script adds AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET and AUTH0_AUDIENCE to
// .env and leaves the rest of the file alone. It never writes the management
// credentials; delete them from .env after setup if you don't need them.
// Needed scopes: create/read/update:clients,
// read:client_keys, create/read/update:resource_servers,
// create/read/update:client_grants, read/update/create:connections.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "./load-env.mjs";

// Pick up AUTH0_DOMAIN / AUTH0_MGMT_* from .env so you can put them there
// instead of prefixing the command.
loadEnvFile(new URL("../.env", import.meta.url).pathname);

const APP_NAME = "Anonymous Sessions - General Demo";
const API_NAME = "Anonymous Sessions Demo API";
const API_IDENTIFIER = process.env.AUTH0_AUDIENCE || "https://anon-sessions-demo.local/api";

const domain = (process.env.AUTH0_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
if (!domain) fail("AUTH0_DOMAIN is not set. Put it in .env or prefix the command with it (e.g. your-tenant.us.auth0.com — your tenant's domain, or custom domain).");

function fail(msg) {
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
}

async function getMgmtToken() {
  if (process.env.AUTH0_MGMT_TOKEN) return process.env.AUTH0_MGMT_TOKEN;
  const id = process.env.AUTH0_MGMT_CLIENT_ID;
  const secret = process.env.AUTH0_MGMT_CLIENT_SECRET;
  if (!id || !secret) {
    fail(
      "Provide management access: either AUTH0_MGMT_TOKEN, or AUTH0_MGMT_CLIENT_ID + AUTH0_MGMT_CLIENT_SECRET\n" +
        "(a Machine-to-Machine app authorized for the Auth0 Management API). See README > Setup."
    );
  }
  const res = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
      audience: `https://${domain}/api/v2/`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`Could not get a Management API token (${res.status}): ${JSON.stringify(data)}`);
  return data.access_token;
}

const token = await getMgmtToken();

async function api(method, path, body) {
  const res = await fetch(`https://${domain}/api/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function step(label, fn) {
  try {
    const out = await fn();
    console.log(`✓ ${label}`);
    return out;
  } catch (e) {
    fail(`${label} failed.\n${e.message}`);
  }
}

// 1. Resource server (API)
const resourceServer = await step(`API "${API_NAME}" (${API_IDENTIFIER})`, async () => {
  const existing = await api("GET", `/resource-servers/${encodeURIComponent(API_IDENTIFIER)}`).catch(() => null);
  const config = {
    name: API_NAME,
    subject_type_authorization: { anonymous_user: { policy: "require_client_grant" } },
  };
  if (existing?.id) return api("PATCH", `/resource-servers/${existing.id}`, config);
  return api("POST", "/resource-servers", { identifier: API_IDENTIFIER, ...config });
});

// 2. Application (regular_web / confidential)
const client = await step(`Application "${APP_NAME}"`, async () => {
  const list = await api("GET", `/clients?fields=client_id,name&include_fields=true&per_page=100`);
  const existing = list.find((c) => c.name === APP_NAME);
  const config = {
    app_type: "regular_web",
    oidc_conformant: true, // API-created clients default to false; Anonymous Sessions requires true
    grant_types: [
      "refresh_token",
      "http://auth0.com/oauth/grant-type/passwordless/otp",
    ],
    anonymous_sessions: { active: true },
  };
  if (existing) return api("PATCH", `/clients/${existing.client_id}`, config);
  return api("POST", "/clients", { name: APP_NAME, ...config });
});

// 3. Client grant for anonymous users
await step("Client grant (subject_type: anonymous_user)", async () => {
  const grants = await api("GET", `/client-grants?client_id=${client.client_id}&audience=${encodeURIComponent(API_IDENTIFIER)}`);
  const has = (Array.isArray(grants) ? grants : grants.client_grants || []).some(
    (g) => g.subject_type === "anonymous_user"
  );
  if (has) return;
  await api("POST", "/client-grants", {
    client_id: client.client_id,
    audience: API_IDENTIFIER,
    scope: [],
    subject_type: "anonymous_user",
  });
});

// 4. Passwordless email connection
let emailNote = "";
await step("Passwordless Email connection enabled for the app", async () => {
  const conns = await api("GET", "/connections?strategy=email");
  let conn = (Array.isArray(conns) ? conns : conns.connections || [])[0];
  if (!conn) {
    conn = await api("POST", "/connections", {
      name: "email",
      strategy: "email",
      options: {
        email: {
          syntax: "liquid",
          from: "{{ application.name }} <root@auth0.com>",
          subject: "Your sign-in code",
          body: "<html><body><p>Your code is <b>{{ password }}</b></p></body></html>",
        },
        authParams: { scope: "openid email profile offline_access" },
        brandingColor: "#000000",
        disable_signup: false,
        totp: { length: 6, time_step: 300 },
      },
    });
    emailNote =
      "Created a new 'email' connection using Auth0's built-in sender. Auth0's default email provider is rate-limited\n" +
      "  and for testing only — configure your own provider (Dashboard > Branding > Email Provider) for reliable delivery.";
  }
  // Enabled clients are managed via a dedicated endpoint (not a connection PATCH field).
  await api("PATCH", `/connections/${conn.id}/clients`, [{ client_id: client.client_id, status: true }]);
});

// 5. Client secret
const full = await api("GET", `/clients/${client.client_id}?fields=client_id,client_secret&include_fields=true`);
if (!full.client_secret) fail("Could not read the client secret (token needs the read:client_keys scope).");

// 6. Write the generated values into .env, updating those keys in place and
// leaving every other line (domain, management credentials, ...) untouched.
const generated = {
  AUTH0_CLIENT_ID: full.client_id,
  AUTH0_CLIENT_SECRET: full.client_secret,
  AUTH0_AUDIENCE: API_IDENTIFIER,
};
const envPath = new URL("../.env", import.meta.url).pathname;
const existingLines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
const remaining = new Set(Object.keys(generated));
const updated = existingLines.map((line) => {
  const key = line.replace(/^\s*export\s+/, "").split("=")[0].trim();
  if (remaining.has(key) && line.includes("=")) {
    remaining.delete(key);
    return `${key}=${generated[key]}`;
  }
  return line;
});
while (updated.length && updated[updated.length - 1] === "") updated.pop();
for (const key of remaining) updated.push(`${key}=${generated[key]}`);
writeFileSync(envPath, updated.join("\n") + "\n", { mode: 0o600 });
console.log("\n✓ Wrote AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET and AUTH0_AUDIENCE to .env (gitignored)");
if (emailNote) console.log(`\nNote: ${emailNote}`);
console.log("\nDone. Run: npm start");
