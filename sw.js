"use strict";

const UV_CONFIG = {
  prefix:   "/uv/service/",
  version:  "uv-proxy-v2",
};

function encode(str) {
  try {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  } catch { return null; }
}
function decode(str) {
  try {
    const pad = (4 - (str.length % 4)) % 4;
    return decodeURIComponent(
      escape(atob((str + "====".slice(0, pad)).replace(/-/g, "+").replace(/_/g, "/")))
    );
  } catch { return null; }
}

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== UV_CONFIG.version).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const BLOCKED_REQ_HEADERS = new Set([
  "host","origin","referer","x-forwarded-for","x-forwarded-host",
  "x-forwarded-proto","x-real-ip","forwarded","via",
  "connection","upgrade","proxy-connection","proxy-authorization",
  "te","trailer","transfer-encoding",
]);

const BLOCKED_RES_HEADERS = new Set([
  "content-security-policy","content-security-policy-report-only",
  "x-frame-options","x-content-type-options",
  "strict-transport-security","expect-ct",
  "permissions-policy","feature-policy",
  "cross-origin-embedder-policy","cross-origin-opener-policy",
  "cross-origin-resource-policy",
]);

function buildRequestHeaders(original, parsedTarget) {
  const headers = new Headers();
  for (const [k, v] of original.entries()) {
    if (!BLOCKED_REQ_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("host",    parsedTarget.host);
  headers.set("origin",  parsedTarget.origin);
  headers.set("referer", parsedTarget.href);
  if (!headers.has("user-agent")) {
    headers.set("user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
  }
  return headers;
}

function sanitizeResponseHeaders(original) {
  const headers = new Headers();
  for (const [k, v] of original.entries()) {
    if (!BLOCKED_RES_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("access-control-allow-origin",      "*");
  headers.set("access-control-allow-methods",     "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD");
  headers.set("access-control-allow-headers",     "*");
  headers.set("access-control-expose-headers",    "*");
  headers.set("access-control-allow-credentials", "true");
  headers.set("timing-allow-origin",              "*");
  return headers;
}

function rewriteSetCookie(cookieStr) {
  return cookieStr
    .replace(/;\s*domain=[^;]*/gi,   "")
    .replace(/;\s*samesite=[^;]*/gi, "")
    .replace(/;\s*secure/gi,         "")
    + "; SameSite=None; Secure";
}

self.addEventListener("fetch", event => {
  const req    = event.request;
  const reqUrl = new URL(req.url);

  if (!reqUrl.pathname.startsWith(UV_CONFIG.prefix)) return;

  event.respondWith(handleRequest(req, reqUrl));
});

async function handleRequest(req, reqUrl, redirectCount = 0) {
  if (redirectCount > 10) {
    return new Response("Too many redirects (SW)", { status: 508 });
  }

  const encodedPart = reqUrl.pathname.slice(UV_CONFIG.prefix.length);
  if (!encodedPart) {
    return new Response("No target URL", { status: 400 });
  }

  const decoded = decode(encodedPart);
  if (!decoded) {
    return new Response("Invalid encoded URL (SW)", { status: 400 });
  }

  let targetUrl = decoded;
  if (reqUrl.search) {
    const baseTarget = decoded.split("?")[0];
    targetUrl = baseTarget + reqUrl.search;
  }

  let parsedTarget;
  try { parsedTarget = new URL(targetUrl); }
  catch { return new Response("Malformed target URL (SW)", { status: 400 }); }

  const bareUrl = self.location.origin + UV_CONFIG.prefix + encode(targetUrl);

  const reqHeaders = buildRequestHeaders(req.headers, parsedTarget);

  let body = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  let bareRes;
  try {
    bareRes = await fetch(bareUrl, {
      method:      req.method,
      headers:     reqHeaders,
      body,
      redirect:    "manual",
      credentials: "omit",
      mode:        "same-origin",
    });
  } catch (err) {
    return networkErrorPage(targetUrl, err.message);
  }

  if ([301, 302, 303, 307, 308].includes(bareRes.status)) {
    const location = bareRes.headers.get("location");
    if (location) {
      const newUrl = new URL(location, self.location.origin);
      if (newUrl.pathname.startsWith(UV_CONFIG.prefix)) {
        const newReq = new Request(newUrl.href, {
          method:  bareRes.status === 303 ? "GET" : req.method,
          headers: reqHeaders,
        });
        return handleRequest(newReq, newUrl, redirectCount + 1);
      }
      try {
        const absLoc = new URL(location, parsedTarget.href).href;
        return handleRequest(
          new Request(UV_CONFIG.prefix + encode(absLoc), { method: "GET", headers: reqHeaders }),
          new URL(UV_CONFIG.prefix + encode(absLoc), self.location.origin),
          redirectCount + 1
        );
      } catch {
        return Response.redirect(location, bareRes.status);
      }
    }
  }

  const resHeaders = sanitizeResponseHeaders(bareRes.headers);

  const setCookies = bareRes.headers.getAll
    ? bareRes.headers.getAll("set-cookie")
    : [bareRes.headers.get("set-cookie")].filter(Boolean);
  if (setCookies.length) {
    resHeaders.set("set-cookie", rewriteSetCookie(setCookies[0]));
  }

  const body2 = await bareRes.arrayBuffer();

  return new Response(body2, {
    status:     bareRes.status,
    statusText: bareRes.statusText,
    headers:    resHeaders,
  });
}

function networkErrorPage(targetUrl, reason) {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>Proxy Error</title>
<style>
  body{font-family:monospace;background:#0a0a0f;color:#c8ccd8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .box{border:1px solid #ff4757;padding:32px 40px;max-width:480px;}
  h2{color:#ff4757;margin:0 0 16px;}
  p{color:#555670;font-size:13px;line-height:1.7;}
  code{background:#111118;border:1px solid #2a2a3a;padding:2px 8px;color:#00ffe0;font-size:12px;}
</style>
</head>
<body>
<div class="box">
  <h2>// CONNECTION FAILED</h2>
  <p>Target: <code>${targetUrl}</code></p>
  <p>Reason: <code>${reason}</code></p>
  <p>Make sure <code>node server.js</code> is running and the target site is reachable.</p>
</div>
</body></html>`;
  return new Response(html, {
    status: 502,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

self.addEventListener("message", event => {
  const { type, data, id } = event.data || {};
  const port = event.ports && event.ports[0];

  const reply = result => port && port.postMessage({ id, ...result });

  switch (type) {
    case "ENCODE":
      reply({ encoded: encode(data) });
      break;
    case "DECODE":
      reply({ decoded: decode(data) });
      break;
    case "PING":
      reply({ pong: true, version: UV_CONFIG.version });
      break;
    case "SKIP_WAITING":
      self.skipWaiting();
      break;
    case "NAVIGATE": {
      self.clients.matchAll({ type: "window" }).then(clients => {
        clients.forEach(c => c.navigate && c.navigate(UV_CONFIG.prefix + encode(data)));
      });
      break;
    }
  }
});
