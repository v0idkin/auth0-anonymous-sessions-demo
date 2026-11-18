# Anonymous Sessions — general demo

A single-origin demo of Auth0 Anonymous Sessions: no cross-domain identity
transfer, no mkcert, no `/etc/hosts`, no reverse proxy. One small
Node server, one browser tab, ordinary first-party cookies.

This demo isolates just the anonymous-session mechanics, with no
multi-domain apparatus, so it's small and broadly useful on its own.

## Quick start

1. Get an Auth0 tenant with Anonymous Sessions enabled and a Management API
   credential (details in [Setup](#setup-any-auth0-tenant)).
2. `cp .env.example .env` and fill in `AUTH0_DOMAIN`, `AUTH0_MGMT_CLIENT_ID`
   and `AUTH0_MGMT_CLIENT_SECRET`.
3. `npm run setup` — creates the app, API, grant and email connection on your
   tenant, and adds `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` and
   `AUTH0_AUDIENCE` to `.env` for you.
4. `npm start`, then open http://localhost:8787.

Nothing in this repo is tied to a particular tenant; all tenant config lives
in the gitignored `.env`.

## What it shows

1. Open the page. You're anonymous — but not "no identity at all." Auth0
   issues a real, signed anonymous session the moment the page loads.
2. Add a few items to a cart. That cart is stored against the anonymous
   identity Auth0 gave you (its actual `sub` claim, not a client-generated
   UUID).
3. Sign in with a passwordless email OTP — no password, no separate
   signup form.
4. The cart you built anonymously is still there, now attached to your
   authenticated profile. Nothing was lost in the handoff.

## Live Auth0 call log

Every request the backend makes to Auth0 — anonymous session creation,
renewal, OTP send/verify, session refresh — shows up in a panel at the
bottom of the page in real time, in order, with secrets/tokens redacted
(truncated, not hidden entirely, so you can still see roughly what came
back). Click any row to expand the full request and response. This is
meant to make the "what is actually happening" part of the demo visible
instead of just asserted — useful for walking someone through it who
hasn't seen Anonymous Sessions before.

It's implemented as a simple in-memory log exposed at `GET
/api/debug/calls` (and cleared via `DELETE`) — not authenticated, so this
is a local/demo convenience only; don't deploy this server anywhere public
without locking that route down.

## Testing this yourself

See **`TESTING_GUIDE.md`** for a step-by-step walkthrough written for
someone who's never touched this repo before — good for handing to a
colleague. It includes the tenant setup step, so it works from a fresh clone.

## Setup (any Auth0 tenant)

You need an Auth0 tenant with **Anonymous Sessions** available (if the
`anonymous_sessions` setting is rejected when the script runs, it isn't
enabled on your tenant yet — ask Auth0 to turn it on).

Everything below is created for you by `scripts/setup-auth0.mjs`; the manual
equivalents are listed afterwards.

### 1. Create a Management API credential (one-time, only used by the setup script)

Auth0 Dashboard → Applications → Create Application → **Machine to Machine**
→ authorize it for the **Auth0 Management API** with these scopes:
`create:clients read:clients update:clients read:client_keys
create:resource_servers read:resource_servers update:resource_servers
create:client_grants read:client_grants create:connections read:connections
update:connections`.

(Alternative: copy a short-lived token from Applications → APIs → Auth0
Management API → API Explorer and pass it as `AUTH0_MGMT_TOKEN`.)

### 2. Add your tenant and credentials to `.env`

```bash
cp .env.example .env
```

Then fill in the three values at the top:

```
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_MGMT_CLIENT_ID=<m2m client id>
AUTH0_MGMT_CLIENT_SECRET=<m2m client secret>
```

### 3. Run the setup script (Node 18+)

```bash
npm run setup
```

It is idempotent (safe to re-run) and:

- creates the API **"Anonymous Sessions Demo API"**
  (`https://anon-sessions-demo.local/api`) with
  `subject_type_authorization.anonymous_user.policy = require_client_grant`;
- creates the **regular_web (confidential)** application
  **"Anonymous Sessions - General Demo"** with `anonymous_sessions.active: true`
  and the passwordless-OTP grant;
- creates the client grant with `subject_type: anonymous_user`;
- enables the passwordless **email** connection for the app (creating the
  connection if the tenant has none);
- adds `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` and `AUTH0_AUDIENCE` to
  `.env`, leaving the rest of the file as it was. The management credentials
  are only read, never written elsewhere. You can delete them from `.env`
  after setup; the running demo doesn't use them.

### Or do it by hand

Create the same four things in the dashboard/Management API, then create
`.env` with `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` (the
app's **Client ID and Client Secret**) and `AUTH0_AUDIENCE` (the API
identifier). The management credentials aren't needed in that case.

**Email delivery:** Auth0's built-in email sender is for testing only and is
heavily rate-limited. Configure your own provider (Branding → Email
Provider) if OTP codes don't arrive.

**Why regular_web instead of SPA**: the legacy `passwordless-otp` grant type
is not available to public SPA clients on every tenant. Since the browser
never talks to Auth0 directly in this demo (the server proxies every call,
matching the architecture Auth0 recommends for confidential clients),
running as a `regular_web` confidential client with a `client_secret` is
correct, not a workaround.

**Anonymous Sessions API shape, confirmed by testing against a live tenant**
(differs from what's suggested by some early Auth0 documentation):
- `POST /anonymous/token` requires an explicit `audience` unless the tenant
  has a `default_audience` configured — it's always passed explicitly here.
- The response body is `{ session_token, access_token, token_type,
  session_expires_in, expires_in }` — there's no `anonymous_id` field. The
  stable anonymous identifier is the `sub` claim (`anon@<uuid>`) inside the
  decoded `access_token`.
- Enabling a client for Anonymous Sessions is `PATCH /clients/{id}` with
  `{"anonymous_sessions":{"active":true}}` — a nested object, not a flat
  boolean.
- The anon-session cookie name (if you inspect Auth0's own response) is
  `auth0_anon`, not `anon`.

## Running it

```bash
npm start            # http://localhost:8787
PORT=3000 npm start  # different port
```

There are no dependencies to install — just Node 18+.

Open `http://localhost:8787`. If config is missing, the page tells you which
variables are unset. No TLS setup, no hosts file, no second process.

## What this deliberately does NOT demonstrate

This is the general-audience version of the story, not the hardest version
of it. It intentionally leaves out:

- **Cross-domain identity transfer.** Everything here is one origin. If
  you need to show an anonymous identity surviving a hop between two
  genuinely separate domains, that's a materially harder problem — Auth0's
  own purpose-built mechanism for that (`anon_transfer_token`, redeemed via
  `/authorize`) was tested directly against a live tenant and confirmed to
  always require a visible redirect through Universal Login, with no
  headless path available today.
- **Real payment/checkout.** The cart is illustrative; nothing here
  processes a transaction.
- **Persistence across server restarts.** State lives in an in-memory
  `Map` — restarting the server wipes everything. Fine for a live demo,
  not a real backend.
