/**
 * Minimal static file server for the exported bundle (./out).
 *
 * In the target architecture a CDN serves ./out and this file is unused - see
 * docs/DEPLOYMENT.md. It exists so a self-hosted `docker compose -f
 * docker-compose.yml -f docker-compose.prod.yml up` still has something
 * serving the frontend, without adding a dependency or a second image for
 * what is ultimately 1.6 MB of static files.
 *
 * Deliberately not a general-purpose server: no caching headers beyond the
 * immutable /_next/static rule, no directory listing. Put a CDN or Caddy in
 * front of it for anything real.
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { pipeline } from "node:stream";
import {
  createBrotliCompress,
  createGzip,
  constants as zlibConstants,
} from "node:zlib";

const ROOT = resolve("./out");
const PORT = Number(process.env.PORT ?? 3000);

/**
 * Content-Security-Policy for the exported bundle.
 *
 * connect-src has to name the API and WebSocket origins explicitly, because
 * they are on a different host to the bundle and 'self' would block them. They
 * come from the same env vars the build inlines, so a deployment that points
 * the app at a different API automatically gets a policy that allows it.
 *
 * script-src keeps 'unsafe-inline': a static export ships Next's hydration
 * payload as an inline <script> with no nonce, and there is no server render
 * pass in which to add one. The policy is still worth setting - it is what
 * stops injected markup loading or beaconing to an origin we do not list,
 * which is how an XSS actually exfiltrates anything.
 */
function contentSecurityPolicy() {
  const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const ws = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";
  return [
    "default-src 'self'",
    `connect-src 'self' ${api} ${ws}`,
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Sent on every response. HSTS is included only when the deployment says it is
// behind TLS: pinning https on a plain-http host makes the site unreachable,
// and browsers ignore the header on http anyway.
const SECURITY_HEADERS = {
  "Content-Security-Policy": contentSecurityPolicy(),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
  ...(process.env.ENABLE_HSTS === "true"
    ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
    : {}),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

// Compress these and nothing else. .woff2, .png and .ico are already
// compressed formats: re-encoding them burns CPU to add a few bytes, and is
// the one way a naive "compress everything" server makes responses larger.
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".txt"]);

// Below this the framing overhead is most of the payload and the round trip
// dominates anyway. Matches the API's GZipMiddleware threshold.
const MIN_COMPRESS_BYTES = 512;

/**
 * Pick an encoding from Accept-Encoding, or null for identity.
 *
 * Brotli first when offered: on the Next bundle it beats gzip by ~15% at a
 * quality level that still keeps up with disk. Deliberately not parsing
 * q-values - a client that advertises an encoding it does not want is not a
 * case worth the parser.
 */
function negotiateEncoding(acceptEncoding, ext, size) {
  if (!COMPRESSIBLE.has(ext) || size < MIN_COMPRESS_BYTES) return null;
  const accepted = (acceptEncoding ?? "").toLowerCase();
  if (accepted.includes("br")) return "br";
  if (accepted.includes("gzip")) return "gzip";
  return null;
}

function compressor(encoding, size) {
  if (encoding === "br") {
    return createBrotliCompress({
      params: {
        // 5, not the default 11: 11 is an offline-packaging setting that costs
        // hundreds of milliseconds per megabyte. 5 lands within a few percent
        // of it at a fraction of the CPU, and SIZE_HINT lets brotli size its
        // window to the file instead of the default 4 MB.
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: size,
      },
    });
  }
  return createGzip({ level: 6 });
}

/** Resolve a URL path to a file inside ROOT, or null if it escapes. */
async function resolveFile(urlPath) {
  // normalize() collapses ".." before we join, so a crafted path cannot climb
  // out of ROOT.
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(
    /^(\.\.[/\\])+/,
    ""
  );
  let candidate = join(ROOT, clean);
  if (!candidate.startsWith(ROOT)) return null;

  try {
    const info = await stat(candidate);
    // trailingSlash: true means every route is a directory holding index.html.
    if (info.isDirectory()) candidate = join(candidate, "index.html");
    else return candidate;
  } catch {
    // A bare route with no trailing slash, e.g. /app
    candidate = join(candidate, "index.html");
  }

  try {
    await stat(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Rendered output, already encoded, keyed by (file, encoding).
 *
 * The export is one set of pages served identically to every visitor, so
 * re-reading and re-compressing them per request is pure repetition: the
 * bundle is 1.6 MB and brotli at quality 5 is the most expensive thing this
 * process does. Entries are validated against the file's mtime and size, so a
 * rebuild into ./out is picked up without a restart.
 *
 * The key would need Accept-Language too if the export ever ships localised
 * routes; today `next build` emits one language, and locale-specific routes
 * would be distinct paths (/fr/...), which the key already separates.
 */
const CACHE = new Map();
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_FILE_BYTES = 2 * 1024 * 1024;
let cacheBytes = 0;

function cacheGet(key, info) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  // A rebuild replaces the file; serving the old bytes would pin a stale app
  // until the container restarted.
  if (hit.mtimeMs !== info.mtimeMs || hit.rawSize !== info.size) {
    CACHE.delete(key);
    cacheBytes -= hit.body.length;
    return null;
  }
  return hit;
}

function cacheSet(key, entry) {
  if (entry.body.length > CACHE_MAX_FILE_BYTES) return;
  // Nothing clever on eviction: the working set is a fixed bundle, so the cap
  // exists to bound a pathological ./out, not to be tuned.
  if (cacheBytes + entry.body.length > CACHE_MAX_BYTES) {
    CACHE.clear();
    cacheBytes = 0;
  }
  CACHE.set(key, entry);
  cacheBytes += entry.body.length;
}

/** Read a file fully and encode it, returning the bytes to send. */
function encodeFile(file, encoding, size) {
  return new Promise((resolve, reject) => {
    const source = createReadStream(file);
    if (!encoding) {
      const chunks = [];
      source.on("data", (c) => chunks.push(c));
      source.on("error", reject);
      source.on("end", () => resolve(Buffer.concat(chunks)));
      return;
    }
    const chunks = [];
    const zip = compressor(encoding, size);
    zip.on("data", (c) => chunks.push(c));
    // Resolve on the compressor's own "end", not on pipeline's callback: the
    // callback can fire before the last chunks have been emitted, which
    // silently caches a truncated body.
    zip.on("end", () => resolve(Buffer.concat(chunks)));
    // pipeline(), not pipe(): it tears the whole chain down on error instead
    // of leaving the compressor holding the file handle.
    pipeline(source, zip, (err) => {
      if (err) reject(err);
    });
  });
}

const server = createServer(async (req, res) => {
  const file = (await resolveFile(req.url ?? "/")) ?? join(ROOT, "404.html");
  const ext = extname(file);
  const type = MIME[ext] ?? "application/octet-stream";

  let info;
  try {
    info = await stat(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY_HEADERS });
    res.end("Not found");
    return;
  }

  const encoding = negotiateEncoding(
    req.headers["accept-encoding"],
    ext,
    info.size
  );
  const status = file.endsWith("404.html") ? 404 : 200;
  const key = `${file}|${encoding ?? "identity"}`;

  let entry = cacheGet(key, info);
  if (!entry) {
    let body;
    try {
      body = await encodeFile(file, encoding, info.size);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain", ...SECURITY_HEADERS });
      res.end("Read error");
      return;
    }
    // Derived from the file, not the encoded bytes, so gzip and brotli copies
    // of one build agree - and it changes whenever the build does.
    entry = {
      body,
      mtimeMs: info.mtimeMs,
      rawSize: info.size,
      etag: `"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`,
    };
    cacheSet(key, entry);
  }

  const headers = {
    "Content-Type": type,
    // Next fingerprints everything under /_next/static, so it is safe to pin.
    "Cache-Control": req.url?.startsWith("/_next/static")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate",
    // Always sent, even on the identity path: a shared cache that stored the
    // uncompressed copy without this would hand it to a client expecting br.
    Vary: "Accept-Encoding",
    ETag: entry.etag,
    ...(encoding ? { "Content-Encoding": encoding } : {}),
    ...SECURITY_HEADERS,
  };

  // must-revalidate above means the browser asks every time; answering with a
  // 304 is what makes that cheap. HTML is where this pays - the fingerprinted
  // assets are already pinned for a year and never ask.
  const inm = req.headers["if-none-match"];
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === entry.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  res.writeHead(status, { ...headers, "Content-Length": String(entry.body.length) });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(entry.body);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[web] serving ./out on :${PORT}`);
});
