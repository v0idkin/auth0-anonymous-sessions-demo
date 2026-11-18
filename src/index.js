// Anonymous Sessions — general-purpose, single-origin demo.
//
// There is NO cross-domain component here at all: one server, one origin, ordinary
// first-party cookies. That means no mkcert, no /etc/hosts, no reverse
// proxy — just `npm start` and a browser pointed at localhost.
//
// The story this demonstrates: a visitor browses a small product catalog
// anonymously, adds items to a cart (stored against a real Auth0-issued
// anonymous identity, not a client-side-invented one), then logs in with
// a passwordless email OTP — and the cart they built anonymously is still
// there under their authenticated profile.
//
// All Auth0 calls happen server-side, in this server — the browser never
// talks to Auth0 directly. Session state is an in-memory Map, which is
// fine for a demo (`npm start`) and wiped on restart; this is not
// persistence, it's a prototype.
//
// Every call to Auth0 is also recorded into an in-memory call log
// (`callLog`), with secrets redacted, and exposed via GET /api/debug/calls
// so the page can render a live "what actually happened" panel. This is a
// demo/debug convenience only — it's not authenticated, so don't deploy
// this server anywhere public without locking that route down first.

const sessions = new Map(); // sessionId -> { refreshToken, profile, createdAt }
const cartsByIdentity = new Map(); // "anon:<sub>" | "user:<sub>" -> [ { id, name, price } ]

const CATALOG = [
  { id: "sku-1", name: "Trail Running Shoes", price: 89 },
  { id: "sku-2", name: "Insulated Water Bottle", price: 24 },
  { id: "sku-3", name: "Packable Rain Jacket", price: 64 },
  { id: "sku-4", name: "Merino Wool Socks (3-pack)", price: 18 },
];

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function sessionCookieHeader(sessionId, { clear = false, secure = true } = {}) {
  const maxAge = clear ? 0 : 60 * 60 * 24 * 30;
  const value = clear ? "" : sessionId;
  // First-party cookie, same origin as everything else — no SameSite=None,
  // no third-party context, no browser privacy policy in play at all.
  return `anon_demo_session=${value}; Path=/;${secure ? " Secure;" : ""} HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function identityKey({ sub, anonId }) {
  return sub ? `user:${sub}` : `anon:${anonId}`;
}

function mergeCarts(fromKey, toKey) {
  if (fromKey === toKey) return cartsByIdentity.get(toKey) || [];
  const from = cartsByIdentity.get(fromKey) || [];
  const to = cartsByIdentity.get(toKey) || [];
  const merged = [...to, ...from.filter((item) => !to.some((t) => t.id === item.id))];
  cartsByIdentity.set(toKey, merged);
  cartsByIdentity.delete(fromKey);
  return merged;
}

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// --- Call log: records every Auth0 request/response for the debug viewer ---

const callLog = [];
const MAX_LOG_ENTRIES = 40;

// Keys that are bearer credentials or otherwise sensitive — never shown in
// full in the viewer, even though this server itself needs the real values
// to make the calls. Truncated rather than fully hidden so it's still
// obvious *that* a token was present and roughly how large it is.
const SENSITIVE_KEYS = new Set([
  "client_secret",
  "session_token",
  "access_token",
  "refresh_token",
  "id_token",
  "otp",
  "anon_transfer_token",
]);

function redact(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key) && typeof val === "string") {
      out[key] = val.length > 20 ? `${val.slice(0, 10)}…${val.slice(-6)} (redacted, ${val.length} chars)` : "•".repeat(val.length);
    } else if (typeof val === "object") {
      out[key] = redact(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function logCall({ label, method, path, requestBody, status, responseBody, durationMs, error }) {
  callLog.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    label,
    method,
    path,
    request: redact(requestBody),
    status,
    response: error ? { error } : redact(responseBody),
    durationMs,
  });
  if (callLog.length > MAX_LOG_ENTRIES) callLog.length = MAX_LOG_ENTRIES;
}

// --- Auth0 calls (all server-side; browser never talks to Auth0 directly) ---

async function auth0AnonymousToken(env, sessionToken) {
  const body = {
    client_id: env.AUTH0_CLIENT_ID,
    client_secret: env.AUTH0_CLIENT_SECRET,
    audience: env.AUTH0_AUDIENCE,
    scope: "openid anon",
  };
  if (sessionToken) body.session_token = sessionToken;

  const start = Date.now();
  let status, data, errorMessage;
  try {
    const res = await fetch(`https://${env.AUTH0_DOMAIN}/anonymous/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    data = safeJsonParse(text);
    if (!res.ok) throw new Error(`anon token endpoint returned ${res.status}: ${text}`);
    return data;
  } catch (err) {
    errorMessage = String(err);
    throw err;
  } finally {
    logCall({
      label: sessionToken ? "Anonymous session renewed" : "Anonymous session created",
      method: "POST",
      path: "/anonymous/token",
      requestBody: body,
      status,
      responseBody: data && data.access_token ? { ...data, _decoded_access_token: decodeJwt(data.access_token) } : data,
      durationMs: Date.now() - start,
      error: errorMessage,
    });
  }
}

async function auth0PasswordlessStart(env, email) {
  const body = {
    client_id: env.AUTH0_CLIENT_ID,
    client_secret: env.AUTH0_CLIENT_SECRET,
    connection: "email",
    email,
    send: "code",
  };

  const start = Date.now();
  let status, data, errorMessage;
  try {
    const res = await fetch(`https://${env.AUTH0_DOMAIN}/passwordless/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    data = safeJsonParse(text);
    if (!res.ok) throw new Error(`passwordless/start failed (${res.status}): ${text}`);
    return data;
  } catch (err) {
    errorMessage = String(err);
    throw err;
  } finally {
    logCall({
      label: "Passwordless OTP requested",
      method: "POST",
      path: "/passwordless/start",
      requestBody: body,
      status,
      responseBody: data,
      durationMs: Date.now() - start,
      error: errorMessage,
    });
  }
}

async function auth0PasswordlessVerify(env, email, code) {
  const body = {
    client_id: env.AUTH0_CLIENT_ID,
    client_secret: env.AUTH0_CLIENT_SECRET,
    grant_type: "http://auth0.com/oauth/grant-type/passwordless/otp",
    username: email,
    otp: code,
    realm: "email",
    scope: "openid profile email offline_access",
  };

  const start = Date.now();
  let status, data, errorMessage;
  try {
    const res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    data = safeJsonParse(text);
    if (!res.ok) throw new Error(`otp verify failed (${res.status}): ${text}`);
    return data; // { access_token, id_token, refresh_token, ... }
  } catch (err) {
    errorMessage = String(err);
    throw err;
  } finally {
    logCall({
      label: "Passwordless OTP verified",
      method: "POST",
      path: "/oauth/token (passwordless-otp grant)",
      requestBody: body,
      status,
      responseBody: data && data.id_token ? { ...data, _decoded_id_token: decodeJwt(data.id_token) } : data,
      durationMs: Date.now() - start,
      error: errorMessage,
    });
  }
}

async function auth0Refresh(env, refreshToken) {
  const body = {
    client_id: env.AUTH0_CLIENT_ID,
    client_secret: env.AUTH0_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };

  const start = Date.now();
  let status, data, errorMessage;
  try {
    const res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    data = safeJsonParse(text);
    if (!res.ok) throw new Error(`refresh failed (${res.status}): ${text}`);
    return data;
  } catch (err) {
    errorMessage = String(err);
    throw err;
  } finally {
    logCall({
      label: "Session refreshed (refresh_token grant)",
      method: "POST",
      path: "/oauth/token (refresh_token grant)",
      requestBody: body,
      status,
      responseBody: data,
      durationMs: Date.now() - start,
      error: errorMessage,
    });
  }
}

// --- HTTP routes ---

async function handleApi(request, env, url) {
  if (url.pathname === "/api/catalog" && request.method === "GET") {
    return json({ items: CATALOG });
  }

  if (url.pathname === "/api/debug/calls" && request.method === "GET") {
    return json({ calls: callLog });
  }

  if (url.pathname === "/api/debug/calls" && request.method === "DELETE") {
    callLog.length = 0;
    return json({ ok: true });
  }

  if (url.pathname === "/api/session" && request.method === "GET") {
    const sessionId = getCookie(request, "anon_demo_session");
    const session = sessionId && sessions.get(sessionId);
    if (!session) return json({ authenticated: false });
    try {
      const refreshed = await auth0Refresh(env, session.refreshToken);
      if (refreshed.refresh_token) session.refreshToken = refreshed.refresh_token;
      const cart = cartsByIdentity.get(identityKey({ sub: session.profile.sub })) || [];
      return json({ authenticated: true, profile: session.profile, cart });
    } catch (err) {
      sessions.delete(sessionId);
      return json(
        { authenticated: false, error: String(err) },
        { headers: { "Set-Cookie": sessionCookieHeader(sessionId, { clear: true, secure: url.protocol === "https:" }) } }
      );
    }
  }

  if (url.pathname === "/api/anon/start" && request.method === "POST") {
    const { sessionToken } = await request.json().catch(() => ({}));
    try {
      const data = await auth0AnonymousToken(env, sessionToken);
      const claims = decodeJwt(data.access_token || "");
      return json({ anonId: claims.sub, sessionToken: data.session_token, viaAuth0: true });
    } catch (err) {
      return json({ viaAuth0: false, error: String(err) }, { status: 502 });
    }
  }

  if (url.pathname === "/api/cart" && request.method === "GET") {
    const sessionId = getCookie(request, "anon_demo_session");
    const session = sessionId && sessions.get(sessionId);
    const anonId = url.searchParams.get("anonId");
    const key = session ? identityKey({ sub: session.profile.sub }) : identityKey({ anonId });
    return json({ cart: cartsByIdentity.get(key) || [] });
  }

  if (url.pathname === "/api/cart" && request.method === "POST") {
    const { anonId, item } = await request.json();
    const sessionId = getCookie(request, "anon_demo_session");
    const session = sessionId && sessions.get(sessionId);
    const key = session ? identityKey({ sub: session.profile.sub }) : identityKey({ anonId });
    const cart = cartsByIdentity.get(key) || [];
    if (!cart.some((c) => c.id === item.id)) cart.push(item);
    cartsByIdentity.set(key, cart);
    return json({ cart });
  }

  if (url.pathname === "/api/cart" && request.method === "DELETE") {
    const { anonId, itemId } = await request.json();
    const sessionId = getCookie(request, "anon_demo_session");
    const session = sessionId && sessions.get(sessionId);
    const key = session ? identityKey({ sub: session.profile.sub }) : identityKey({ anonId });
    const cart = (cartsByIdentity.get(key) || []).filter((c) => c.id !== itemId);
    cartsByIdentity.set(key, cart);
    return json({ cart });
  }

  if (url.pathname === "/api/passwordless/start" && request.method === "POST") {
    const { email } = await request.json();
    if (!email) return json({ error: "email required" }, { status: 400 });
    try {
      await auth0PasswordlessStart(env, email);
      return json({ sent: true });
    } catch (err) {
      return json({ error: String(err) }, { status: 502 });
    }
  }

  if (url.pathname === "/api/passwordless/verify" && request.method === "POST") {
    const { email, code, anonId } = await request.json();
    try {
      const tokens = await auth0PasswordlessVerify(env, email, code);
      const profile = { ...decodeJwt(tokens.id_token || ""), email };
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { refreshToken: tokens.refresh_token, profile, createdAt: Date.now() });

      // Anonymous -> known transfer. Native production pattern is an
      // Actions hook reading event.anonymous_session; done inline here for
      // the demo, same as a cross-domain setup would.
      const userKey = identityKey({ sub: profile.sub });
      if (anonId) mergeCarts(identityKey({ anonId }), userKey);

      return json(
        { authenticated: true, profile, cart: cartsByIdentity.get(userKey) || [] },
        { headers: { "Set-Cookie": sessionCookieHeader(sessionId, { secure: url.protocol === "https:" }) } }
      );
    } catch (err) {
      return json({ error: String(err) }, { status: 401 });
    }
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    const sessionId = getCookie(request, "anon_demo_session");
    if (sessionId) sessions.delete(sessionId);
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookieHeader(sessionId, { clear: true, secure: url.protocol === "https:" }) } });
  }

  return json({ error: "not found" }, { status: 404 });
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Anonymous Sessions Demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f7f7f8; color: #1a1a1a; }
  header { background: #1a1a2e; color: white; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
  header h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .pill { font-size: 12px; padding: 4px 10px; border-radius: 12px; background: #2d2d44; color: #b8b8d0; }
  .pill.known { background: #2e6b3e; color: #d6f5dd; }
  main { max-width: 900px; margin: 32px auto 0; padding: 0 24px; display: grid; grid-template-columns: 1.4fr 1fr; gap: 24px; }
  .wrap { max-width: 900px; margin: 24px auto 40px; padding: 0 24px; }
  .card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card h2 { margin-top: 0; font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; color: #666; }
  .product { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; }
  .product:last-child { border-bottom: none; }
  .product-name { font-weight: 500; }
  .product-price { color: #666; margin-left: 8px; font-size: 13px; }
  button { cursor: pointer; border: none; border-radius: 6px; font-size: 13px; padding: 7px 14px; }
  button.add { background: #1a1a2e; color: white; }
  button.remove { background: #f1f1f4; color: #444; }
  button.primary { width: 100%; background: #1a1a2e; color: white; padding: 10px; font-size: 14px; margin-top: 8px; }
  .cart-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #eee; }
  .cart-empty { color: #999; font-size: 13px; padding: 12px 0; }
  input { width: 100%; padding: 9px; margin: 6px 0; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
  .banner { background: #fff4e0; border: 1px solid #ffdca0; border-radius: 6px; padding: 10px 12px; font-size: 12px; margin-bottom: 12px; line-height: 1.5; }
  .banner.success { background: #e3f5e6; border-color: #a8dcb2; }
  .muted { color: #888; font-size: 12px; }
  .total { display: flex; justify-content: space-between; font-weight: 600; padding-top: 10px; margin-top: 4px; border-top: 1px solid #ddd; }

  .log-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .log-card-head h2 { margin: 0; }
  .log-card-head button { background: #f1f1f4; color: #444; }
  .log-intro { margin-top: -2px; margin-bottom: 14px; }
  .log-entry { border: 1px solid #eee; border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
  .log-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; font-size: 13px; }
  .log-head:hover { background: #fafafa; }
  .log-badge { font-family: ui-monospace, monospace; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: #eee; flex-shrink: 0; }
  .log-badge.ok { background: #e3f5e6; color: #1e6b2e; }
  .log-badge.err { background: #fbe3e3; color: #a92222; }
  .log-label { font-weight: 600; flex: 1; }
  .log-path { font-family: ui-monospace, monospace; font-size: 11px; color: #888; }
  .log-time { font-size: 11px; color: #aaa; flex-shrink: 0; }
  .log-body { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; background: #fafafa; border-top: 1px solid #eee; }
  .log-col-title { font-size: 11px; text-transform: uppercase; color: #999; margin-bottom: 4px; letter-spacing: 0.03em; }
  .log-body pre { margin: 0; font-size: 11px; background: #1a1a2e; color: #d8d8ea; padding: 10px; border-radius: 6px; overflow-x: auto; max-height: 260px; white-space: pre-wrap; word-break: break-all; }
  @media (max-width: 720px) {
    main { grid-template-columns: 1fr; }
    .log-body { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <header>
    <h1>🛒 Anonymous Sessions Demo</h1>
    <span id="who" class="pill">anonymous</span>
  </header>
  <main>
    <div class="card">
      <h2>Catalog</h2>
      <div id="catalog"></div>
    </div>
    <div class="card">
      <h2>Your Cart</h2>
      <div id="cart-area"></div>
      <div id="auth-area"></div>
    </div>
  </main>

  <div class="wrap">
    <div class="card">
      <div class="log-card-head">
        <h2>Auth0 Call Log</h2>
        <button onclick="onClearLog()">Clear</button>
      </div>
      <p class="muted log-intro">Every request this page's backend makes to Auth0, in the order it happened. Secrets and tokens are redacted — click a row to see the full request and response.</p>
      <div id="call-log"></div>
    </div>
  </div>

  <script>
    const state = { anonId: null, anonSessionToken: null, authenticated: false, profile: null, cart: [], catalog: [], callLog: [], expandedLogs: {} };

    function getStoredAnon() {
      return {
        anonId: localStorage.getItem("anon_demo_id"),
        sessionToken: localStorage.getItem("anon_demo_session_token"),
      };
    }
    function setStoredAnon(anonId, sessionToken) {
      localStorage.setItem("anon_demo_id", anonId);
      if (sessionToken) localStorage.setItem("anon_demo_session_token", sessionToken);
      state.anonId = anonId;
    }
    function clearStoredAnon() {
      localStorage.removeItem("anon_demo_id");
      localStorage.removeItem("anon_demo_session_token");
    }

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    async function api(path, opts = {}) {
      const res = await fetch(path, { credentials: "include", headers: { "content-type": "application/json" }, ...opts });
      return res.json();
    }

    async function bootstrap() {
      const catalogRes = await api("/api/catalog");
      state.catalog = catalogRes.items;

      const session = await api("/api/session");
      if (session.authenticated) {
        state.authenticated = true;
        state.profile = session.profile;
        state.cart = session.cart;
      } else {
        const { sessionToken } = getStoredAnon();
        const anon = await api("/api/anon/start", { method: "POST", body: JSON.stringify({ sessionToken }) });
        if (anon.anonId) setStoredAnon(anon.anonId, anon.sessionToken);
        const cartRes = await api("/api/cart?anonId=" + encodeURIComponent(state.anonId));
        state.cart = cartRes.cart || [];
      }
      render();
      refreshCallLog();
    }

    async function addToCart(item) {
      const body = { anonId: state.anonId, item };
      const res = await api("/api/cart", { method: "POST", body: JSON.stringify(body) });
      state.cart = res.cart;
      render();
    }

    async function removeFromCart(itemId) {
      const body = { anonId: state.anonId, itemId };
      const res = await api("/api/cart", { method: "DELETE", body: JSON.stringify(body) });
      state.cart = res.cart;
      render();
    }

    async function requestOtp(email) {
      return api("/api/passwordless/start", { method: "POST", body: JSON.stringify({ email }) });
    }

    async function verifyOtp(email, code) {
      const res = await api("/api/passwordless/verify", { method: "POST", body: JSON.stringify({ email, code, anonId: state.anonId }) });
      if (res.authenticated) {
        state.authenticated = true;
        state.profile = res.profile;
        state.cart = res.cart;
        clearStoredAnon();
      }
      return res;
    }

    async function logout() {
      await api("/api/logout", { method: "POST" });
      state.authenticated = false;
      state.profile = null;
      state.cart = [];
      state.anonId = null;
      clearStoredAnon();
      bootstrap();
    }

    function renderCatalog() {
      document.getElementById("catalog").innerHTML = state.catalog.map((p) => \`
        <div class="product">
          <div>
            <span class="product-name">\${p.name}</span>
            <span class="product-price">\$\${p.price}</span>
          </div>
          <button class="add" onclick="onAdd('\${p.id}')">Add to cart</button>
        </div>
      \`).join("");
    }

    function render() {
      document.getElementById("who").textContent = state.authenticated ? state.profile.email : "anonymous";
      document.getElementById("who").classList.toggle("known", state.authenticated);
      renderCatalog();

      const cartArea = document.getElementById("cart-area");
      const total = state.cart.reduce((sum, item) => sum + (item.price || 0), 0);
      cartArea.innerHTML = state.cart.length
        ? state.cart.map((item) => \`
            <div class="cart-item">
              <span>\${item.name} <span class="product-price">\$\${item.price}</span></span>
              <button class="remove" onclick="onRemove('\${item.id}')">Remove</button>
            </div>
          \`).join("") + \`<div class="total"><span>Total</span><span>\$\${total}</span></div>\`
        : '<div class="cart-empty">Cart is empty — add something from the catalog.</div>';

      const authArea = document.getElementById("auth-area");
      if (state.authenticated) {
        authArea.innerHTML = \`
          <div class="banner success">Signed in as <strong>\${state.profile.email}</strong>. This cart is now attached to your account — not your browser session.</div>
          <button class="primary" style="background:#c0392b" onclick="logout()">Sign out</button>
        \`;
      } else {
        authArea.innerHTML = \`
          <div class="banner">You're anonymous right now — this cart exists, but only Auth0 knows who "you" are (a real anonymous session, not a browser cookie). Sign in and watch it follow you.</div>
          <input id="email" type="email" placeholder="you@example.com" />
          <button class="primary" onclick="onRequestOtp()">Email me a code</button>
          <div id="otp-area"></div>
        \`;
      }
    }

    async function onAdd(id) {
      const item = state.catalog.find((p) => p.id === id);
      if (item) await addToCart(item);
    }
    async function onRemove(id) {
      await removeFromCart(id);
    }

    async function onRequestOtp() {
      const email = document.getElementById("email").value;
      if (!email) return;
      const res = await requestOtp(email);
      const area = document.getElementById("otp-area");
      if (res.error) {
        area.innerHTML = \`<p class="muted">\${res.error}</p>\`;
      } else {
        area.innerHTML = \`
          <input id="otp-code" placeholder="6-digit code" />
          <button class="primary" onclick="onVerifyOtp('\${email}')">Verify</button>
        \`;
      }
      refreshCallLog();
    }

    async function onVerifyOtp(email) {
      const code = document.getElementById("otp-code").value;
      const res = await verifyOtp(email, code);
      if (res.error) {
        document.getElementById("otp-area").innerHTML = \`<p class="muted">\${res.error}</p>\`;
      } else {
        render();
      }
      refreshCallLog();
    }

    // --- Call log viewer ---

    async function refreshCallLog() {
      const res = await api("/api/debug/calls");
      state.callLog = res.calls || [];
      renderCallLog();
    }

    function renderCallLog() {
      const el = document.getElementById("call-log");
      if (!el) return;
      if (!state.callLog.length) {
        el.innerHTML = '<p class="muted">No Auth0 calls yet — interact with the demo above and they will appear here.</p>';
        return;
      }
      el.innerHTML = state.callLog.map((c, i) => {
        const ok = typeof c.status === "number" && c.status >= 200 && c.status < 300;
        return \`
          <div class="log-entry">
            <div class="log-head" onclick="toggleLog(\${i})">
              <span class="log-badge \${ok ? "ok" : "err"}">\${c.status || "ERR"}</span>
              <span class="log-label">\${escapeHtml(c.label)}</span>
              <span class="log-path">\${escapeHtml(c.method)} \${escapeHtml(c.path)}</span>
              <span class="log-time">\${new Date(c.time).toLocaleTimeString()} · \${c.durationMs}ms</span>
            </div>
            <div class="log-body" id="log-body-\${i}" style="display:\${state.expandedLogs[i] ? "grid" : "none"}">
              <div>
                <div class="log-col-title">Request sent to Auth0</div>
                <pre>\${escapeHtml(JSON.stringify(c.request, null, 2))}</pre>
              </div>
              <div>
                <div class="log-col-title">Response from Auth0</div>
                <pre>\${escapeHtml(JSON.stringify(c.response, null, 2))}</pre>
              </div>
            </div>
          </div>
        \`;
      }).join("");
    }

    function toggleLog(i) {
      state.expandedLogs[i] = !state.expandedLogs[i];
      const el = document.getElementById("log-body-" + i);
      if (!el) return;
      el.style.display = state.expandedLogs[i] ? "grid" : "none";
    }

    async function onClearLog() {
      await api("/api/debug/calls", { method: "DELETE" });
      await refreshCallLog();
    }

    window.onAdd = onAdd;
    window.onRemove = onRemove;
    window.onRequestOtp = onRequestOtp;
    window.onVerifyOtp = onVerifyOtp;
    window.logout = logout;
    window.toggleLog = toggleLog;
    window.onClearLog = onClearLog;

    bootstrap();
    setInterval(refreshCallLog, 2500);
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const missing = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_AUDIENCE"].filter((k) => !env[k]);
    if (missing.length) {
      return new Response(
        `Missing Auth0 config: ${missing.join(", ")}.\n` +
          "Run `npm run setup`, or copy .env.example to .env and fill it in. See README.md > Setup.",
        { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(pageHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
