/**
 * Runs the API and the Vite dev server side by side, so `bun run dev` is the
 * only command anyone needs. Vite proxies /api through to the API port.
 */
const procs = [
  Bun.spawn(["bun", "--hot", "server/index.ts"], {
    stdio: ["inherit", "inherit", "inherit"],
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
