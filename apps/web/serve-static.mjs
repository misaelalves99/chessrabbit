/**
 * Minimal static file server for the exported bundle (./out).
 *
 * In the target architecture a CDN serves ./out and this file is unused - see
 * docs/DEPLOYMENT.md. It exists so a self-hosted `docker compose -f
 * docker-compose.yml -f docker-compose.prod.yml up` still has something
 * serving the frontend, without adding a dependency or a second image for
 * what is ultimately 1.6 MB of static files.
 *
 * Deliberately not a general-purpose server: no compression, no caching
 * headers beyond the immutable /_next/static rule, no directory listing. Put
 * a CDN or Caddy in front of it for anything real.
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve("./out");
const PORT = Number(process.env.PORT ?? 3000);

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

const server = createServer(async (req, res) => {
  const file = (await resolveFile(req.url ?? "/")) ?? join(ROOT, "404.html");
  const type = MIME[extname(file)] ?? "application/octet-stream";

  try {
    await stat(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  res.writeHead(file.endsWith("404.html") ? 404 : 200, {
    "Content-Type": type,
    // Next fingerprints everything under /_next/static, so it is safe to pin.
    "Cache-Control": req.url?.startsWith("/_next/static")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate",
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[web] serving ./out on :${PORT}`);
});
