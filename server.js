// Plain Node dev server for the demo — no Cloudflare/Wrangler needed.
// Loads config from .env (or the environment), then serves src/index.js,
// which is a standard fetch(request, env) handler.
//
//   npm start            (or: node server.js)
//   PORT=3000 npm start

import { createServer } from "node:http";
import { loadEnvFile } from "./scripts/load-env.mjs";
import worker from "./src/index.js";

loadEnvFile(new URL("./.env", import.meta.url).pathname);

const port = Number(process.env.PORT) || 8787;
const env = process.env;

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    const hasBody = body && req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://${req.headers.host || `localhost:${port}`}${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? body : undefined,
    });

    const response = await worker.fetch(request, env);

    const out = {};
    for (const [k, v] of response.headers) if (k !== "set-cookie") out[k] = v;
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal server error");
  }
});

server.listen(port, () => console.log(`Ready on http://localhost:${port}`));
