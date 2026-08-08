import { handleApiSafe } from "../server/router";
import { d1Store, type D1 } from "../server/store-d1";

/**
 * Cloudflare Workers entry point.
 *
 * Everything interesting lives in `server/router.ts`, which this shares
 * verbatim with the Bun server — the only things that differ between the two
 * runtimes are where the database comes from, where the client IP comes from,
 * and who serves the static files.
 */
export interface Env {
  DB: D1;
  /** Workers Assets binding — the built `dist/`, served from the edge. */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /**
   * The maintainer's registration secret. Set with
   * `bunx wrangler secret put PIXE_VERIFIED_KEY`, never committed. Absent in
   * any environment that has not set it, in which case nothing served by that
   * environment can ever be verified.
   */
  PIXE_VERIFIED_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // `run_worker_first` in wrangler.jsonc routes only /api/* here, so anything
    // else arriving is a fallthrough — hand it back to the asset server, which
    // resolves unknown paths to index.html for client-side routing.
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    return handleApiSafe(request, url, {
      store: d1Store(env.DB),
      // Set by Cloudflare's edge and not forwardable by the client, unlike
      // x-forwarded-for, which anyone may send.
      ip: request.headers.get("cf-connecting-ip") ?? "unknown",
      // The custom domain is HTTPS-only, so the session cookie is always Secure.
      secure: true,
      verifiedKey: env.PIXE_VERIFIED_KEY,
    });
  },

  /**
   * Expired sessions and stale throttle records need sweeping, and a Worker has
   * no long-lived process to run a timer in. A cron trigger is the equivalent.
   */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await d1Store(env.DB).reap(Date.now());
  },
};
