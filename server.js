"use strict";

const express  = require("express");
const http     = require("http");
const https    = require("https");
const zlib     = require("zlib");
const path     = require("path");
const { URL }  = require("url");
const { Transform, pipeline } = require("stream");

const app  = express();
const PORT = process.env.PORT || 8080;

const UV_CONFIG = {
prefix:      "/uv/service/",
bare:        "/uv/bare/",
encodeUrl:   "/uv/encode",
ping:        "/uv/ping",
swFile:      "/sw.js",
maxRedirects: 10,
timeout:     20000,
skipSchemes: new Set(["data:", "javascript:", "blob:", "about:", "mailto:", "tel:", "#"]),
};

const codec = {
encode(str) {
return Buffer.from(str, "utf8").toString("base64url");
},
decode(str) {
try {
const pad = (4 - (str.length % 4)) % 4;
return Buffer.from(str + "=".repeat(pad), "base64").toString("utf8");
} catch { return null; }
},
};

function collectBody(stream) {
return new Promise((resolve, reject) => {
const chunks = [];
stream.on("data",  c => chunks.push(c));
stream.on("end",   () => resolve(Buffer.concat(chunks)));
stream.on("error", reject);
});
}

function decompress(buf, encoding) {
const enc = (encoding || "").toLowerCase().trim();
try {
if (enc === "gzip")    return zlib.gunzipSync(buf);
if (enc === "deflate") return zlib.inflateSync(buf);
if (enc === "br")      return zlib.brotliDecompressSync(buf);
} catch (e) {
}
return buf;
}

function shouldSkip(val) {
if (!val || !val.trim()) return true;
for (const scheme of UV_CONFIG.skipSchemes) {
if (val.startsWith(scheme)) return true;
}
return false;
}

function proxify(val, base) {
if (shouldSkip(val)) return null;
try {
const abs = new URL(val.trim(), base).href;
return UV_CONFIG.prefix + codec.encode(abs);
} catch { return null; }
}

function resolveBase(html, baseUrl) {
let resolved = baseUrl;
html = html.replace(/<base([^>]?)>/gi, (match, attrs) => {
const hm = attrs.match(/href\s*=\s*(["'])(.*?)\1/i);
if (hm) {
try { resolved = new URL(hm[2].trim(), baseUrl).href; } catch {}
}
return "";
});
return { html, base: resolved };
}

function rewriteSrcset(srcset, base) {
return srcset.split(",").map(part => {
const tokens = part.trim().split(/\s+/);
if (!tokens[0]) return part;
const p = proxify(tokens[0], base);
if (p) tokens[0] = p;
return tokens.join(" ");
}).join(", ");
}

function rewriteAttrs(html, base) {
const singleUrlAttrs = /\b(href|src|action|data-src|data-href|poster|ping|formaction|manifest|background)\s*=\s*(["'])(.*?)\2/gi;
html = html.replace(singleUrlAttrs, (match, attr, q, val) => {
if (shouldSkip(val)) return match;
const p = proxify(val, base);
return p ? `${attr}=${q}${p}${q}` : match;
});

html = html.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (match, q, val) => {
return `srcset=${q}${rewriteSrcset(val, base)}${q}`;
});

html = html.replace(
/(<meta[^>]+content\s*=\s*["'])([^"']+)(["'][^>]*>)/gi,
(match, pre, content, post) => {
const refreshMatch = content.match(/^(\d+;\s*url=)(.+)$/i);
if (refreshMatch) {
const p = proxify(refreshMatch[2].trim(), base);
return p ? `${pre}${refreshMatch[1]}${p}${post}` : match;
}
if (/^https?:\/\//.test(content.trim())) {
const p = proxify(content.trim(), base);
return p ? `${pre}${p}${post}` : match;
}
return match;
}
);

return html;
}

function rewriteStyleAttr(html, base) {
return html.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (match, q, style) => {
const rewritten = rewriteCss(style, base, true);
return `style=${q}${rewritten}${q}`;
});
}

function rewriteHtml(raw, targetUrl) {
const prefix = UV_CONFIG.prefix;
let { html, base } = resolveBase(raw, targetUrl);

html = rewriteAttrs(html, base);
html = rewriteStyleAttr(html, base);

html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, css) => {
return `<style${attrs}>${rewriteCss(css, base, false)}</style>`;
});

html = html.replace(
/<meta[^>]+http-equiv\s*=\s*["']content-security-policy["'][^>]*>/gi,
""
);

const runtime = buildRuntime(base, targetUrl);
if (/<head([^>]*)>/i.test(html)) {
html = html.replace(/<head([^>]*)>/i, `<head$1>${runtime}`);
} else if (/<html([^>]*)>/i.test(html)) {
html = html.replace(/<html([^>]*)>/i, `<html$1>${runtime}`);
} else {
html = runtime + html;
}

return html;
}

function rewriteCss(css, base, inline) {
css = css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, q, val) => {
if (shouldSkip(val)) return match;
const p = proxify(val, base);
return p ? `url(${q}${p}${q})` : match;
});

css = css.replace(/@import\s+(["'])(.*?)\1/gi, (match, q, val) => {
if (shouldSkip(val)) return match;
const p = proxify(val, base);
return p ? `@import ${q}${p}${q}` : match;
});

return css;
}

function rewriteJs(js, base) {
const prefix  = JSON.stringify(UV_CONFIG.prefix);
const baseStr = JSON.stringify(base);

js = js.replace(
/\bimportScripts\((.*?)\)/g,
(match, args) => {
const rewritten = args.replace(/(["'])(https?:\/\/.*?)\1/g, (m, q, url) => {
const p = UV_CONFIG.prefix + codec.encode(url);
return `${q}${p}${q}`;
});
return `importScripts(${rewritten})`;
}
);

js = js.replace(/(["'])(https?:\/\/([^"']{4,})\b.*?)\1/g, (match, q, url) => {
if (url.includes(UV_CONFIG.prefix)) return match;
try {
new URL(url);
return `${q}${UV_CONFIG.prefix}${codec.encode(url)}${q}`;
} catch { return match; }
});

return js;
}

function buildRuntime(base, targetUrl) {
const prefixJson  = JSON.stringify(UV_CONFIG.prefix);
const baseJson    = JSON.stringify(base);
const targetJson  = JSON.stringify(targetUrl);

const encodeFn = `
function __uvEncode(s){ try{ return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,''); }catch(e){return null;} }
function __uvDecode(s){ try{ var p=(4-(s.length%4))%4; s=s+'===='.slice(0,p); return decodeURIComponent(escape(atob(s.replace(/-/g,'+').replace(/_/g,'/')))); }catch(e){return null;} }
function __uvProxify(url){
if(!url||typeof url!=='string') return url;
if(url.startsWith(${prefixJson})||url.startsWith('data:')||url.startsWith('blob:')||url.startsWith('javascript:')) return url;
if(/^https?:\\/\\//.test(url)){ return ${prefixJson}+__uvEncode(url); }
try{ var abs=new URL(url,${baseJson}).href; return ${prefixJson}+__uvEncode(abs); }catch(e){return url;}
}
`;

return `<script>
(function(){
"use strict";
${encodeFn}

var __uvLocation = {
get href(){ return ${targetJson}; },
get origin(){ try{return new URL(${targetJson}).origin;}catch(e){return '';} },
get host(){ try{return new URL(${targetJson}).host;}catch(e){return '';} },
get hostname(){ try{return new URL(${targetJson}).hostname;}catch(e){return '';} },
get pathname(){ try{return new URL(${targetJson}).pathname;}catch(e){return '/';} },
get search(){ try{return new URL(${targetJson}).search;}catch(e){return '';} },
get hash(){ return window.location.hash; },
assign:  function(u){ window.location.assign(__uvProxify(u)); },
replace: function(u){ window.location.replace(__uvProxify(u)); },
toString:function(){ return this.href; },
};
try{ Object.defineProperty(window,'__uvLocation',{value:__uvLocation,writable:false}); }catch(e){}

try{
Object.defineProperty(document,'location',{get:function(){return __uvLocation;},configurable:true});
Object.defineProperty(document,'referrer',{get:function(){return ${targetJson};},configurable:true});
Object.defineProperty(document,'domain',{get:function(){try{return new URL(${targetJson}).hostname;}catch(e){return '';}},configurable:true});
Object.defineProperty(document,'cookie',{
get:function(){ return document.__uvCookieGet ? document.__uvCookieGet() : ''; },
set:function(v){ if(document.__uvCookieSet) document.__uvCookieSet(v); else this.__uvRawCookie=v; },
configurable:true
});
}catch(e){}

(function(){
var _push    = history.pushState.bind(history);
var _replace = history.replaceState.bind(history);
history.pushState = function(state,title,url){
return _push(state,title,url&&/^https?:\/\//.test(url)?__uvProxify(url):url);
};
history.replaceState = function(state,title,url){
return _replace(state,title,url&&/^https?:\/\//.test(url)?__uvProxify(url):url);
};
})();

(function(){
var _fetch = window.fetch;
window.fetch = async function(input,init){
if(typeof input==='string'){
input = __uvProxify(input);
} else if(input instanceof Request){
input = new Request(__uvProxify(input.url),input);
}
const res = await _fetch.call(window,input,init);
if(res.headers.get("x-uv-download")==="1"){
const blob = await res.blob();
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = url;
a.download = "";
document.body.appendChild(a);
a.click();
a.remove();
setTimeout(()=>{ URL.revokeObjectURL(url); },10000);
}
return res;
};
})();

(function(){
var _open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method,url){
var args = Array.prototype.slice.call(arguments);
if(typeof url==='string') args[1] = __uvProxify(url);
return _open.apply(this,args);
};
})();

(function(){
if(!window.WebSocket) return;
var _WS = window.WebSocket;
window.WebSocket = function(url,protocols){
return protocols ? new _WS(url,protocols) : new _WS(url);
};
window.WebSocket.prototype = _WS.prototype;
Object.keys(_WS).forEach(function(k){ window.WebSocket[k]=_WS[k]; });
})();

(function(){
if(!window.Worker) return;
var _Worker = window.Worker;
window.Worker = function(url,opts){
return new _Worker(__uvProxify(url),opts);
};
window.Worker.prototype = _Worker.prototype;
if(window.SharedWorker){
var _SW = window.SharedWorker;
window.SharedWorker = function(url,opts){
return new _SW(__uvProxify(url),opts);
};
window.SharedWorker.prototype = _SW.prototype;
}
})();

(function(){
if(!window.EventSource) return;
var _ES = window.EventSource;
window.EventSource = function(url,init){
return new _ES(__uvProxify(url),init);
};
window.EventSource.prototype = _ES.prototype;
})();

(function(){
var desc = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "href");
Object.defineProperty(HTMLAnchorElement.prototype, "href", {
get(){ return desc.get.call(this); },
set(v){ desc.set.call(this, __uvProxify(v)); }
});
})();

(function(){
var desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
Object.defineProperty(HTMLImageElement.prototype, "src", {
get(){ return desc.get.call(this); },
set(v){ desc.set.call(this, __uvProxify(v)); }
});
})();

(function(){
var desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
Object.defineProperty(HTMLIFrameElement.prototype, "src", {
get(){ return desc.get.call(this); },
set(v){ desc.set.call(this, __uvProxify(v)); }
});
})();

(function(){
[HTMLMediaElement.prototype, HTMLVideoElement.prototype, HTMLAudioElement.prototype].forEach(proto => {
var desc = Object.getOwnPropertyDescriptor(proto, "src");
if(!desc) return;
Object.defineProperty(proto, "src", {
get(){ return desc.get.call(this); },
set(v){ desc.set.call(this, __uvProxify(v)); }
});
});
})();

(function(){
var desc = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, "src");
if(!desc) return;
Object.defineProperty(HTMLSourceElement.prototype, "src", {
get(){ return desc.get.call(this); },
set(v){ desc.set.call(this, __uvProxify(v)); }
});
})();

(function(){
var original = URL.createObjectURL;
URL.createObjectURL = function(blob){ return original.call(URL, blob); };
})();

(function(){
var observer = new MutationObserver(records => {
for(const record of records){
for(const node of record.addedNodes){
if(node.nodeType!==1) continue;
if(node.src) node.src=__uvProxify(node.src);
if(node.href) node.href=__uvProxify(node.href);
}
}
});
observer.observe(document.documentElement, { subtree:true, childList:true });
})();

(function(){
var _open = window.open;
window.open = function(url,name,features){
if(url&&typeof url==='string'&&/^https?:\/\//.test(url)){
url = __uvProxify(url);
}
return _open.call(window,url,name,features);
};
})();

window.__uv = {encode:__uvEncode,decode:__uvDecode,proxify:__uvProxify,base:${baseJson},target:${targetJson}};

})();
</script>`;
}

const BLOCKED_REQ_HEADERS = new Set([
"host","origin","referer","x-forwarded-for","x-forwarded-host",
"x-forwarded-proto","x-real-ip","forwarded","via","connection",
"upgrade","proxy-connection","proxy-authorization","te","trailer",
"transfer-encoding",
]);

function buildForwardHeaders(incomingHeaders, parsedTarget) {
const out = {};
for (const [k, v] of Object.entries(incomingHeaders)) {
if (!BLOCKED_REQ_HEADERS.has(k.toLowerCase())) out[k] = v;
}
out["host"]            = parsedTarget.host;
out["origin"]          = parsedTarget.origin;
out["referer"]         = parsedTarget.href;
out["accept-encoding"] = "gzip, deflate, br";
if (!out["user-agent"]) {
out["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
}
return out;
}

const BLOCKED_RES_HEADERS = new Set([
"content-security-policy","content-security-policy-report-only",
"x-frame-options","x-content-type-options",
"strict-transport-security","expect-ct",
"permissions-policy","feature-policy",
"cross-origin-embedder-policy","cross-origin-opener-policy",
"cross-origin-resource-policy",
"content-encoding",
"transfer-encoding",
"trailer","te",
"upgrade",
]);

function sanitizeResHeaders(incomingHeaders) {
const out = {};
for (const [k, v] of Object.entries(incomingHeaders)) {
if (!BLOCKED_RES_HEADERS.has(k.toLowerCase())) out[k] = v;
}

out["access-control-allow-origin"]      = "";
out["access-control-allow-methods"]     = "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD";
out["access-control-allow-headers"]     = "";
out["access-control-expose-headers"]    = "";
out["access-control-allow-credentials"] = "true";
out["timing-allow-origin"]              = "";

if (out["set-cookie"]) {
const cookies = [].concat(out["set-cookie"]);
out["set-cookie"] = cookies.map(c =>
c.replace(/;\s*domain=[^;]*/gi, "")
.replace(/;\s*samesite=[^;]*/gi, "")
.replace(/;\s*secure/gi, "")
+ "; SameSite=None; Secure"
);
}
return out;
}

async function handleProxyRequest(req, res, targetUrl, redirectCount = 0) {
if (redirectCount > UV_CONFIG.maxRedirects) {
return res.status(508).send("Too many redirects");
}

let parsed;
try { parsed = new URL(targetUrl); }
catch { return res.status(400).send("Malformed URL: " + targetUrl); }

const lib = parsed.protocol === "https:" ? https : http;

const reqHeaders = buildForwardHeaders(req.headers, parsed);

const options = {
hostname: parsed.hostname,
port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
path:     parsed.pathname + parsed.search,
method:   req.method,
headers:  reqHeaders,
timeout:  UV_CONFIG.timeout,
rejectUnauthorized: false,
};

return new Promise((resolve) => {
const proxyReq = lib.request(options, async (proxyRes) => {
try {
if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
const loc = proxyRes.headers["location"];
if (loc) {
try {
const absLoc = new URL(loc, parsed.href).href;
const newMethod = proxyRes.statusCode === 303 ? "GET" : req.method;
if (newMethod === "GET" || newMethod === "HEAD") {
proxyRes.resume();
return resolve(
handleProxyRequest(req, res, absLoc, redirectCount + 1)
);
}
res.redirect(proxyRes.statusCode, UV_CONFIG.prefix + codec.encode(absLoc));
} catch {
res.redirect(proxyRes.statusCode, loc);
}
return resolve();
}
}

const contentDisposition = proxyRes.headers["content-disposition"];
const isDownload = contentDisposition && /attachment/i.test(contentDisposition);

if (isDownload) {
const rawBuf = await collectBody(proxyRes);
const headers = sanitizeResHeaders(proxyRes.headers);
headers["x-uv-download"] = "1";
delete headers["content-encoding"];
headers["content-length"] = rawBuf.length;
res.writeHead(proxyRes.statusCode, headers);
res.end(rawBuf);
return resolve();
}

const resHeaders = sanitizeResHeaders(proxyRes.headers);    
const contentType = (proxyRes.headers["content-type"] || "").toLowerCase();    
const contentEnc  = proxyRes.headers["content-encoding"] || "";    

const isHtml = contentType.includes("text/html");    
const isCss  = contentType.includes("text/css");    
const isJs   = contentType.includes("javascript") ||    
               contentType.includes("ecmascript") ||    
               contentType.includes("x-javascript");    
const isText = contentType.startsWith("text/") ||    
               contentType.includes("json") ||    
               contentType.includes("xml");    
const needsRewrite = isHtml || isCss || isJs;    

if (!needsRewrite) {    
  delete resHeaders["content-length"];    
  if (contentEnc) resHeaders["content-encoding"] = contentEnc;    
  res.writeHead(proxyRes.statusCode, resHeaders);    
  proxyRes.pipe(res);    
  proxyRes.on("end", resolve);    
  proxyRes.on("error", resolve);    
  return;    
}    

const rawBuf = await collectBody(proxyRes);    
const buf    = decompress(rawBuf, contentEnc);    

let text = buf.toString("utf8");    
const charsetMatch = contentType.match(/charset\s*=\s*([^\s;]+)/i);    
const charset = charsetMatch ? charsetMatch[1].toLowerCase().replace(/-/g,"") : "utf8";    
if (charset !== "utf8" && charset !== "utf-8") {    
  try {    
    const dec = new TextDecoder(charset, { fatal: false });    
    text = dec.decode(buf);    
  } catch {}    
}    

let rewritten;    
if (isHtml) {    
  rewritten = rewriteHtml(text, parsed.href);    
  resHeaders["content-type"] = "text/html; charset=utf-8";    
} else if (isCss) {    
  rewritten = rewriteCss(text, parsed.href, false);    
  resHeaders["content-type"] = "text/css; charset=utf-8";    
} else if (isJs) {    
  rewritten = rewriteJs(text, parsed.href);    
  resHeaders["content-type"] = "application/javascript; charset=utf-8";    
} else {    
  rewritten = text;    
}    

const outBuf = Buffer.from(rewritten, "utf8");    
resHeaders["content-length"] = outBuf.length;    
res.writeHead(proxyRes.statusCode, resHeaders);    
res.end(outBuf);    
resolve();    

} catch (err) {    
if (!res.headersSent) res.status(500).send("Proxy response error: " + err.message);    
resolve();    
}    
});    

proxyReq.on("timeout", () => {    
proxyReq.destroy();    
if (!res.headersSent) res.status(504).send("Gateway timeout");    
resolve();    
});    

proxyReq.on("error", (err) => {    
if (!res.headersSent) res.status(502).send("Bad gateway: " + err.message);    
resolve();    
});    

if (req.method !== "GET" && req.method !== "HEAD") {    
req.pipe(proxyReq);    
} else {    
proxyReq.end();    
}

});
}

app.use(express.static(path.join(__dirname), { index: "index.html" }));

app.options(UV_CONFIG.prefix + "*", (req, res) => {
res.set({
"access-control-allow-origin":  "*",
"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
"access-control-allow-headers": "*",
}).status(204).end();
});

app.all(UV_CONFIG.prefix + "*", async (req, res) => {
const raw = req.url.slice(UV_CONFIG.prefix.length);
const encodedPart = req.path.slice(UV_CONFIG.prefix.length);
const queryStr    = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";

const decoded = codec.decode(encodedPart);
if (!decoded) return res.status(400).send("Invalid encoded URL");

const targetUrl = queryStr ? decoded.split("?")[0] + queryStr : decoded;

await handleProxyRequest(req, res, targetUrl);
});

app.get(UV_CONFIG.encodeUrl, (req, res) => {
const { url: rawUrl } = req.query;
if (!rawUrl) return res.status(400).json({ error: "url required" });
try {
new URL(rawUrl);
res.json({
encoded:  codec.encode(rawUrl),
prefix:   UV_CONFIG.prefix,
proxyUrl: UV_CONFIG.prefix + codec.encode(rawUrl),
});
} catch {
res.status(400).json({ error: "Invalid URL" });
}
});

app.get(UV_CONFIG.ping, (req, res) => {
res.json({ ok: true, time: Date.now(), version: "2.0.0" });
});

app.listen(PORT, () => {
console.log(`╔══════════════════════════════════════════════════╗\n║  UV Proxy v2  —  http://localhost:${PORT}           ║\n╠══════════════════════════════════════════════════╣\n║  prefix  : ${UV_CONFIG.prefix.padEnd(38)}║\n║  ping    : /uv/ping                             ║\n║  encode  : /uv/encode?url=<url>                 ║\n╚══════════════════════════════════════════════════╝`);
});
