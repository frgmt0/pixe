import { file } from "bun";
import { join } from "node:path";
import { handleApiSafe } from "./router";
import { sqliteStore } from "./store-sqlite";

const PORT = Number(process.env.PORT ?? 3001);
const PROD = process.env.NODE_ENV === "production";
const DIST = join(import.meta.dir, "..", "dist");

const store = sqliteStore();

/** Drop expired sessions and throttle records on boot and hourly thereafter. */
const sweep = () => void store.reap(Date.now());
sweep();
setInterval(sweep, 60 * 60 * 1000).unref?.();

/* ------------------------------------------------------------------ */
/* Static assets + SPA fallback                                        */
/* ------------------------------------------------------------------ */

async function serveStatic(url: URL): Promise<Response> {
  if (!PROD) {
    return new Response("Run `bun run dev` — Vite serves the client on :5173 in development.", {
      status: 404,
    });
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (rel && !rel.includes("..")) {
    const f = file(join(DIST, rel));
    if (await f.exists()) {
      const immutable = rel.startsWith("assets/");
      return new Response(f, {
        headers: immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {},
      });
    }
  }
  // Everything else is a client route.
  return new Response(file(join(DIST, "index.html")), {
    headers: { "content-type": "text/html", "cache-control": "no-cache" },
  });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return serveStatic(url);

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      server.requestIP(req)?.address ||
      "unknown";

    return handleApiSafe(req, url, {
      store,
      ip,
      secure: PROD,
      // Bun's own process env locally; the Worker reads the equivalent from
      // its env binding — see worker/index.ts.
      verifiedKey: process.env.PIXE_VERIFIED_KEY,
    });
  },
});

console.log(`pixe api listening on http://localhost:${server.port}${PROD ? " (serving dist/)" : ""}`);
