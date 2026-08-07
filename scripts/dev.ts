/**
 * Runs the API and the Vite dev server side by side, so `bun run dev` is the
 * only command anyone needs. Vite proxies /api through to the API port.
 */
/**
 * Pairing sends a human to a URL, and the API would otherwise name its own
 * origin — correct in production, where one hostname serves both, but :3001 in
 * development, which is the half that has no page on it. Vite's port is where
 * the person actually needs to land.
 */
const VITE_ORIGIN = process.env.PIXE_PUBLIC_ORIGIN ?? "http://localhost:5173";

const procs = [
  Bun.spawn(["bun", "--hot", "server/index.ts"], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, PIXE_PUBLIC_ORIGIN: VITE_ORIGIN },
  }),
  Bun.spawn(["bunx", "vite"], { stdio: ["inherit", "inherit", "inherit"] }),
];

const shutdown = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// If either half dies, take the other down rather than leaving a half-running app.
await Promise.race(procs.map((p) => p.exited));
shutdown();

export {};
