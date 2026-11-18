# Anonymous Sessions Demo — Testing Guide

This is a short, self-contained demo of Auth0 Anonymous Sessions: a
visitor browses and builds a cart with **no login at all**, then signs in
with a passwordless email code, and everything they did anonymously is
still there under their account. There's also a live "Auth0 Call Log"
panel on the page itself, so you can see exactly what's being sent to
Auth0 and what comes back at every step.

No cross-domain setup, no `/etc/hosts`, no TLS certs, no sudo needed —
it's a single local web server on one port.

Expect this to take about 10 minutes end to end.

---

## What you'll need

- **Node.js** (v18+). Check with `node --version`. If you don't have it,
  grab it from [nodejs.org](https://nodejs.org) or via `nvm`.
- **Access to an email inbox** you can check quickly, since Step 5 sends
  you a real 6-digit login code.
- **An Auth0 tenant with Anonymous Sessions enabled.** You can use your
  own tenant (Step 3 sets the demo app up on it for you) or one that
  someone has already set up for you. If a colleague already ran the
  setup, ask them for the four values listed in Step 3 instead. Never
  commit them.

---

## Step 1 — Clone the repo

```bash
git clone <this-repo-url> anon-sessions-demo
cd anon-sessions-demo
```

---

## Step 2 — Check Node

```bash
node --version
```

**Check:** prints `v18` or higher. There is nothing to install: the demo
has no dependencies.

---

## Step 3 — Configure Auth0

The demo reads four values from a gitignored `.env` file in the repo
root: `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` and
`AUTH0_AUDIENCE`. Pick **one** of these:

**Option A — set up your own tenant (recommended).** Follow README →
*Setup (any Auth0 tenant)* to create a Machine-to-Machine credential for
the Management API, then:

```bash
cp .env.example .env
```

Fill in `AUTH0_DOMAIN`, `AUTH0_MGMT_CLIENT_ID` and `AUTH0_MGMT_CLIENT_SECRET`
in `.env`, and run:

```bash
npm run setup
```

The script creates the API, the app, the client grant and the passwordless
email connection, then adds `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` and
`AUTH0_AUDIENCE` to your `.env` for you.

**Option B — someone already set up a tenant for you.** Create `.env`
yourself with the four values they gave you (`AUTH0_DOMAIN`,
`AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_AUDIENCE`). You don't need
the management credentials or the setup script.

**Check:**

```bash
cat .env
```

All four variables (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_AUDIENCE`) should have real values, not blanks or placeholders.
(Printing the file shows the client secret, so don't do this on a shared
screen.) The file is gitignored and won't get committed.

---

## Step 4 — Start the server

```bash
npm start
```

**Check:** you should see `Ready on http://localhost:8787` with no red
error output. Leave this running — it needs to stay open for the whole
demo. Open a new terminal tab/window if you need to run other commands.

---

## Step 5 — Open the demo and walk through the anonymous → known flow

Open **http://localhost:8787** in a browser.

1. **Check the header pill.** It should say "anonymous." That's not
   nothing, though — scroll down to the "Auth0 Call Log" panel at the
   bottom of the page and click the first entry (**"Anonymous session
   created"**). Expand it. You're looking at a real call this page's
   backend just made to Auth0's `/anonymous/token` endpoint, and a real
   signed identity came back — that `sub` claim inside the decoded access
   token (something like `anon@a1b2c3d4-...`) is your actual identity for
   this session, issued by Auth0, not made up by the browser.

2. **Add two or three items to your cart** from the catalog on the left.
   Watch the call log — you won't see new Auth0 calls for this part
   (adding to a cart doesn't need one), which is worth noting: the cart
   itself is just app data on the backend, keyed by that anonymous
   identity. Auth0's job is establishing *who* you are, not storing what
   you do.

3. **Enter your email** in the sign-in box and click **"Email me a
   code."** Check the call log again — a new entry, **"Passwordless OTP
   requested,"** should appear. Expand it and look at the request: it's a
   call to `/passwordless/start` with your email.

4. **Check your email.** You should get a real 6-digit code within a few
   seconds, subject line depending on your tenant's email
   template (what matters is you get a real code). If you used Auth0's
   built-in email sender, delivery can be slow or rate-limited.

5. **Enter the code and click "Verify."** Watch the call log for
   **"Passwordless OTP verified"** — expand it to see the request that
   included your code, and the response, which includes a decoded ID
   token with your real profile in it (email, a `sub` claim that's now a
   real user identity instead of an anonymous one).

6. **Check the header pill and the cart.** The pill should now show your
   email instead of "anonymous." **The cart should still have every item
   you added anonymously in step 2** — nothing was lost. That handoff is
   the entire point of this demo: an anonymous identity's activity
   surviving the moment it becomes a known one.

7. **Click "Sign out."** You'll drop back to anonymous — a *new*
   anonymous identity this time, with an empty cart. That's expected: this
   demo doesn't persist anything across a real logout, only across the
   specific anonymous → known handoff you just did.

---

## Step 6 — (Optional) Watch a session refresh happen

Reload the page while still signed in from Step 5 (don't sign out first).
Watch the call log — you should see a new entry, **"Session refreshed
(refresh_token grant)."** This is the backend re-authenticating you
server-to-server, without you seeing a login screen or any redirect at
all. If you're demoing this to someone technical, this is worth pointing
out explicitly: the raw refresh token never touches the browser — only an
opaque session cookie does, and the backend redeems it directly against
Auth0.

---

## Step 7 — (Optional) Try renewing the same anonymous identity

If you want to see that the anonymous identity is actually stable (not
regenerated every time), open a private/incognito window, load the page,
add something to the cart, then close and reopen the private window
(same private session, don't fully quit the browser). Reload the page —
your anonymous cart should still be there, because the same session token
is being renewed rather than replaced. You can confirm this in the call
log: the label will say **"Anonymous session renewed"** instead of
**"Anonymous session created"** on the second load.

---

## Pass/fail checklist

- [ ] Step 2: Node 18+ available
- [ ] Step 3: `.env` has all four values
- [ ] Step 4: Server starts clean, no red errors
- [ ] Step 5.1: Page loads, shows "anonymous," first call log entry
      appears with a real decoded `sub` claim
- [ ] Step 5.2: Items add to cart with no errors
- [ ] Step 5.3–4: Real OTP email arrives after clicking "Email me a code"
- [ ] Step 5.5–6: Code verifies, pill switches to your email, **cart items
      from step 5.2 are still present**
- [ ] Step 5.7: Sign out returns to a fresh, empty anonymous cart
- [ ] (Optional) Step 6: reload while signed in shows a "Session
      refreshed" call log entry
- [ ] (Optional) Step 7: anonymous cart survives a reload via session
      renewal, confirmed by the "Anonymous session renewed" label

---

## If something breaks

- **Page shows "Missing Auth0 config":** one or more of the four
  `.env` values is unset; the message lists which. Re-run the setup
  script or fill them in.
- **`401`/`403` or "invalid client" from Auth0 in the call log:** double-check
  `.env` has the right domain, client ID and client secret for the
  *same* tenant, and that you restarted
  the server after creating/editing it (the server reads `.env`
  at startup — save the file, then Ctrl-C and restart if you edited it
  after the server was already running).
- **No email arrives:** check spam first. Auth0's built-in email sender
  is test-only and heavily rate-limited; configure your own provider
  (Dashboard → Branding → Email Provider) and try again. Also confirm the
  `email` connection has this app enabled (Authentication → Passwordless).
- **Cart doesn't carry over after login:** open the call log entry for
  "Passwordless OTP verified" and check whether the request included an
  `anonId` — if the browser's `localStorage` got cleared between adding to
  the cart and logging in (e.g., a hard browser reset), the anonymous
  identity itself would have been lost, which is expected behavior, not a
  bug (see the README's "what this deliberately does NOT demonstrate"
  section).
- **Anything else:** the call log panel is your best debugging tool —
  expand the most recent entry and look at the raw response Auth0 sent
  back before assuming the demo code itself is broken.
