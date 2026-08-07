/**
 * A reference solver. It is deliberately not a good one.
 *
 * The one thing it *is* strict about is how it plays. It opens a real browser,
 * registers through the page, reads the board off the page's own canvases, and
 * paints with keyboard and mouse. It never calls the API — not `/api/next`, not
 * `/api/attest`, and above all not `/api/submit`. Every request the server sees
 * is one the page made because this script did something to it, which is the
 * whole point of the benchmark: a submission is bankable because real input
 * produced it, and the attestation receipt that proves so lives in the page's
 * state where no script outside it can reach.
 *
 * Its deduction, by contrast, is close to nothing: coat the whole board in each
 * hue in turn and note where the board flashes, fill from that map, then
 * recolour whichever stripes are still complaining. It ignores the swatch
 * channel entirely, and a map learnt from a single-colour board is wrong the
 * moment two colours sit next to each other — which is exactly why it stalls.
 * That is the intended baseline. Beating it is not an achievement; the
 * interesting question is by how much, and how fast.
 *
 *   bun add -d playwright && bunx playwright install chromium
 *   PIXE_URL=http://localhost:5173 bun run examples/playwright-solver.ts
 *
 * See examples/README.md for the knobs and for the DOM seams this depends on.
 */

import { chromium, type Browser, type Locator, type Page } from "playwright";
import { EMPTY, GRID, HUE_COUNT, HUE_RGB, hueName } from "../shared/palette";

const BASE = process.env.PIXE_URL ?? "https://pixe.frgmt.xyz";
const OPERATOR_KEY = process.env.PIXE_OPERATOR_KEY ?? "";
const PUZZLES = Number(process.env.PIXE_PUZZLES ?? 1);
const ROUNDS = Number(process.env.PIXE_ROUNDS ?? 24);
const HEADED = process.env.PIXE_HEADED === "1";
/** How long to leave a human to type the pairing code before giving up. */
const PAIR_MS = Number(process.env.PIXE_PAIR_MS ?? 10 * 60 * 1000);

/** A submit is also an observation, but it is the expensive one — the cheap
 *  feedback arrives on the page for free as the board is painted. */
const SUBMIT_EVERY = 4;

/* The board is carved into blocks, each block into horizontal bands, and a band
 * is the unit this solver thinks in: one colour, one rectangle drag, one thing
 * to be wrong about. Coarse on purpose — every zone scheme the generator uses is
 * coarser than a 16-pixel block. */
const BLOCK = 16;
const BLOCKS = GRID / BLOCK;
const BANDS = 4;
const BAND_H = BLOCK / BANDS;
const BAND_COUNT = BLOCKS * BLOCKS * BANDS;

interface Band {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  block: number;
}

function bandAt(i: number): Band {
  const block = Math.floor(i / BANDS);
  const k = i % BANDS;
  const x0 = (block % BLOCKS) * BLOCK;
  const y0 = Math.floor(block / BLOCKS) * BLOCK + k * BAND_H;
  return { x0, y0, x1: x0 + BLOCK - 1, y1: y0 + BAND_H - 1, block };
}

const bandOfCell = (x: number, y: number) =>
  (Math.floor(y / BLOCK) * BLOCKS + Math.floor(x / BLOCK)) * BANDS +
  Math.floor((y % BLOCK) / BAND_H);

/* ------------------------------------------------------------------ */
/* The page, and every seam this script leans on                       */
/* ------------------------------------------------------------------ */

interface Sight {
  /** Hue id per cell, `EMPTY` where the slate shows through. */
  art: Int8Array;
  /** Cells the board is currently flashing at. */
  bad: number[];
  filled: number;
}

/**
 * One place for everything that touches the UI, because the UI is the part of
 * this file that can rot. The protocol underneath it is stable; hotkeys, labels
 * and canvas layers are not, and examples/README.md lists each one.
 */
class Studio {
  constructor(private readonly page: Page) {}

  readonly grid = () => this.page.getByRole("application", { name: /painting grid$/ });
  /** Never disabled, and its label changes once the board says the grid is done. */
  readonly submitButton = () =>
    this.page.getByRole("button", { name: /Submit and see what breaks|Bank it for/ });
  readonly status = () => this.page.locator("p", { hasText: "attested events" }).first();
  readonly solvedDialog = () => this.page.getByRole("dialog").first();

  /** `Rung 3 · L12 · 214 attested events` — the whole of this run's public state. */
  private async statusNumbers(): Promise<{ rung: number; events: number }> {
    const text = await this.status().innerText();
    return {
      rung: Number(text.match(/Rung (\d+)/)?.[1] ?? -1),
      events: Number(text.match(/(\d+) attested events/)?.[1] ?? 0),
    };
  }

  events = async () => (await this.statusNumbers()).events;
  rung = async () => (await this.statusNumbers()).rung;

  /**
   * Wait for the page to have told the server what we just did.
   *
   * The attested event counter only moves when `/api/attest` answers, so this
   * doubles as the acknowledgement that the last burst of painting landed. A
   * counter that stops moving is the first sign something is wrong, and it is
   * visible on screen to a human watching too.
   */
  async attested(above: number, timeoutMs = 20_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const n = await this.events();
      if (n > above) return n;
      if (Date.now() > deadline) return n;
      await this.page.waitForTimeout(120);
    }
  }

  /* --- real input -------------------------------------------------- */

  private box = { x: 0, y: 0, width: 0, height: 0 };

  /** Re-measured before every burst: clicking the sidebar scrolls the page, and
   *  a stale rectangle paints somebody else's pixels. */
  async aim(): Promise<void> {
    const box = await this.grid().boundingBox();
    if (!box) throw new Error("the painting grid is not on screen");
    this.box = box;
  }

  private cx = (x: number) => this.box.x + ((x + 0.5) * this.box.width) / GRID;
  private cy = (y: number) => this.box.y + ((y + 0.5) * this.box.height) / GRID;

  hue = (h: number) => this.page.keyboard.press(String(h + 1));
  tool = (key: "b" | "g" | "r" | "e") => this.page.keyboard.press(key);

  async drag(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    await this.page.mouse.move(this.cx(x0), this.cy(y0));
    await this.page.mouse.down();
    await this.page.mouse.move(this.cx(x1), this.cy(y1), { steps: 3 });
    await this.page.mouse.up();
  }

  /** Fill one band with one hue. The rect tool makes that a single gesture, and
   *  a single gesture is a single attested stroke. */
  async paint(index: number, hue: number): Promise<void> {
    const b = bandAt(index);
    await this.hue(hue);
    await this.drag(b.x0, b.y0, b.x1, b.y1);
  }

  /* --- reading the board ------------------------------------------- */

  /**
   * Both feedback channels, taken off the pixels the player is looking at.
   *
   * The art layer is the grid; the layer stacked on top of it is where the
   * board flashes the cells breaking a placement law. Reading them rather than
   * a local mirror of what we meant to paint is deliberate — a solver whose
   * record and whose canvas disagree is describing itself rather than measuring
   * itself.
   */
  async look(): Promise<Sight> {
    const seen = await this.page.evaluate(
      ({ rgb, size, empty }) => {
        const board = document.querySelector('[role="application"]') ?? document;
        const layers = board.querySelectorAll("canvas");
        const art = layers[0] as HTMLCanvasElement | undefined;
        const marks = layers[1] as HTMLCanvasElement | undefined;
        if (!art || !marks) throw new Error("the board is not two stacked canvases any more");

        const px = art.getContext("2d")!.getImageData(0, 0, size, size).data;
        const flash = marks.getContext("2d")!.getImageData(0, 0, size, size).data;

        const hues: number[] = [];
        const bad: number[] = [];
        for (let i = 0; i < size * size; i++) {
          const r = px[i * 4]!;
          const g = px[i * 4 + 1]!;
          const b = px[i * 4 + 2]!;
          let best = empty;
          // Anything further from a hue than this is the empty slate.
          let near = 40 * 40;
          for (let h = 0; h < rgb.length; h++) {
            const c = rgb[h]!;
            const d = (r - c[0]!) ** 2 + (g - c[1]!) ** 2 + (b - c[2]!) ** 2;
            if (d < near) {
              near = d;
              best = h;
            }
          }
          hues.push(best);
          if (flash[i * 4 + 3]! > 0) bad.push(i);
        }
        return { hues, bad };
      },
      { rgb: HUE_RGB.map((c) => [...c]), size: GRID, empty: EMPTY },
    );

    const art = Int8Array.from(seen.hues);
    let filled = 0;
    for (const v of art) if (v !== EMPTY) filled++;
    return { art, bad: seen.bad, filled };
  }

  /* --- pressing the button ----------------------------------------- */

  /**
   * Click submit and wait for the page's own request to come back. The receipt
   * that request carries was assembled by the page out of the events this
   * script generated; there is no way to produce one from out here, and that is
   * the design rather than an obstacle.
   */
  async submit(): Promise<{ status: number; banked: boolean; note: string }> {
    const answer = this.page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/submit",
      { timeout: 60_000 },
    );
    await this.submitButton().click();
    const res = await answer;
    const status = res.status();
    let note = "";
    if (status !== 200) note = (await res.text()).slice(0, 200);
    // The dialog is the page's answer, and the page is what this script trusts.
    await this.page.waitForTimeout(300);
    return { status, banked: await visible(this.solvedDialog()), note };
  }
}

/* ------------------------------------------------------------------ */
/* Small waiting helpers                                               */
/* ------------------------------------------------------------------ */

const visible = (l: Locator) => l.isVisible().catch(() => false);

/** Poll a set of landmarks and report which one showed up first. */
async function firstOf(
  page: Page,
  options: Record<string, Locator>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const [name, locator] of Object.entries(options)) {
      if (await visible(locator)) return name;
    }
    if (Date.now() > deadline) {
      throw new Error(`none of ${Object.keys(options).join(", ")} appeared in ${timeoutMs}ms`);
    }
    await page.waitForTimeout(250);
  }
}

/* ------------------------------------------------------------------ */
/* Getting a run                                                       */
/* ------------------------------------------------------------------ */

/**
 * Register through the form on `/play`, the same one a person would use.
 *
 * An agent may equally register over the API from inside the page — that is
 * what `agents.txt` documents — but there is nothing to gain here: the form
 * takes the operator key too, and the run token comes back as an HttpOnly
 * cookie either way.
 */
async function register(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Register" });
  const landed = await firstOf(
    page,
    { form: button, grid: page.getByRole("application", { name: /painting grid$/ }) },
    30_000,
  );
  if (landed !== "form") return; // this browser profile already holds a run

  // Nothing to fill but the key, and even that is optional: a run declares no
  // identity of its own, so the form is one field and a button.
  if (OPERATOR_KEY) await page.getByLabel(/^Operator key/).fill(OPERATOR_KEY);
  await button.click();
}

/**
 * The one step that is not ours to take. A person types the code into
 * `/for-humans` and is handed an operator key; set `PIXE_OPERATOR_KEY` from it
 * and every later run skips this entirely.
 */
async function vouched(page: Page): Promise<void> {
  const waiting = page.getByRole("heading", { name: "Ask your human" });
  const landed = await firstOf(
    page,
    {
      pairing: waiting,
      grid: page.getByRole("application", { name: /painting grid$/ }),
      idle: page.getByRole("button", { name: "Take the next puzzle" }),
    },
    30_000,
  );
  if (landed !== "pairing") return;

  const code = (await page.getByText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/).first().innerText()).trim();
  console.log(
    [
      "",
      "  ── say this to your human ──────────────────────────────",
      "  pixe needs you to vouch for this run before I can start.",
      `  Open ${BASE}/for-humans and enter the code ${code}.`,
      "  It will ask your name and which harness you are running me",
      "  under. Twenty seconds, and it hands you a key to save so",
      "  that you never have to do it again.",
      "  ────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
  await waiting.waitFor({ state: "detached", timeout: PAIR_MS });
  console.log("vouched for. starting.\n");
}

/* ------------------------------------------------------------------ */
/* The deduction, such as it is                                        */
/* ------------------------------------------------------------------ */

/** The hue a band is actually wearing, by majority of the pixels on screen. */
function hueOfBand(art: Int8Array, index: number): number {
  const b = bandAt(index);
  const tally = new Int32Array(HUE_COUNT);
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const v = art[y * GRID + x]!;
      if (v !== EMPTY) tally[v]!++;
    }
  }
  let best = 0;
  for (let h = 1; h < HUE_COUNT; h++) if (tally[h]! > tally[best]!) best = h;
  return best;
}

/**
 * Coat the whole board in one hue at a time and write down where it flashed.
 *
 * This costs eight bursts of painting and no submits at all: the page attests
 * as it goes and the board answers on the canvas, so the placement channel is
 * free to anyone already driving the UI. What comes back is a per-hue map of
 * where that colour is tolerated *by its own kind* — which is not the same
 * question as where it is tolerated in the finished picture, and the difference
 * is most of why this solver is a baseline.
 */
async function survey(studio: Studio): Promise<Int32Array[]> {
  const cost: Int32Array[] = [];
  let events = await studio.events();
  for (let h = 0; h < HUE_COUNT; h++) {
    await studio.aim();
    await studio.hue(h);
    for (let strip = 0; strip < BLOCKS; strip++) {
      await studio.drag(0, strip * BLOCK, GRID - 1, strip * BLOCK + BLOCK - 1);
    }
    events = await studio.attested(events);

    const seen = await studio.look();
    const per = new Int32Array(BAND_COUNT);
    for (const cell of seen.bad) per[bandOfCell(cell % GRID, Math.floor(cell / GRID))]!++;
    cost.push(per);
    console.log(`  a coat of ${hueName(h)}: ${seen.bad.length} cells object`);
  }
  return cost;
}

/** Hues for one band, least objectionable first. */
const rank = (cost: Int32Array[], index: number): number[] =>
  Array.from({ length: HUE_COUNT }, (_, h) => h).sort((a, b) => cost[a]![index]! - cost[b]![index]!);

/**
 * Pick a colour for a band, keeping its block's four bands four different
 * colours.
 *
 * That constraint is the only piece of real knowledge in this file: a zone law
 * is a permit list *and* a coverage floor, so a region painted one colour fails
 * by construction no matter how well that colour is tolerated.
 */
function choose(cost: Int32Array[], index: number, taken: Set<number>, skip = 0): number {
  const eligible = rank(cost, index).filter((h) => !taken.has(h));
  const list = eligible.length ? eligible : rank(cost, index);
  // `skip` walks down the ranking as the rounds go by, and wraps. Without it a
  // band that keeps flashing swaps between its two best colours forever; with
  // it clamped instead of wrapped, it sticks on the last one and stops moving.
  return list[skip % list.length]!;
}

/** What the block's other bands are wearing, read off the canvas rather than
 *  off a memory of what was pressed. */
function siblings(art: Int8Array, index: number): Set<number> {
  const block = bandAt(index).block;
  const taken = new Set<number>();
  for (let k = 0; k < BANDS; k++) {
    const other = block * BANDS + k;
    if (other !== index) taken.add(hueOfBand(art, other));
  }
  return taken;
}

/* ------------------------------------------------------------------ */
/* One puzzle                                                          */
/* ------------------------------------------------------------------ */

async function playOne(studio: Studio, page: Page): Promise<boolean> {
  const rung = await studio.rung();
  console.log(`rung ${rung} — asking the board what it thinks of each colour`);

  await studio.tool("r");
  const cost = await survey(studio);

  console.log(`rung ${rung} — filling from that`);
  await studio.aim();
  let events = await studio.events();
  for (let block = 0; block < BLOCKS * BLOCKS; block++) {
    const taken = new Set<number>();
    for (let k = 0; k < BANDS; k++) {
      const index = block * BANDS + k;
      const hue = choose(cost, index, taken);
      taken.add(hue);
      await studio.paint(index, hue);
    }
  }
  events = await studio.attested(events);

  for (let round = 0; round < ROUNDS; round++) {
    const sight = await studio.look();
    const restless = await hotHues(page);
    console.log(
      `  round ${round}: ${sight.filled}/${GRID * GRID} filled, ${sight.bad.length} flashing, ` +
        `${events} attested events` +
        (restless.length ? `, restless: ${restless.join(", ")}` : ""),
    );

    // The button's own label is the board's verdict on whether this is done —
    // it is the same `solved` flag the last round trip came back with.
    const done = await visible(page.getByRole("button", { name: /^Bank it for/ }));
    if (done || round === ROUNDS - 1 || round % SUBMIT_EVERY === SUBMIT_EVERY - 1) {
      const out = await studio.submit();
      console.log(`  submit → ${out.status}${out.banked ? " — banked" : ""}${out.note ? ` ${out.note}` : ""}`);
      if (out.banked) return true;
      events = await studio.events();
    }

    if (sight.bad.length === 0 && sight.filled === GRID * GRID) {
      // A full grid with nothing flashing and no solve means only counting laws
      // are left, and this solver has no answer for those.
      console.log("  nothing is flashing and it still is not a solution. Out of ideas.");
      break;
    }

    const damage = new Int32Array(BAND_COUNT);
    for (const cell of sight.bad) damage[bandOfCell(cell % GRID, Math.floor(cell / GRID))]!++;
    for (let i = 0; i < BAND_COUNT; i++) {
      const b = bandAt(i);
      // An unpainted band is its own kind of damage, and the worst kind: a
      // blank cell can never be part of a solution.
      for (let y = b.y0; y <= b.y1 && damage[i] === 0; y++) {
        for (let x = b.x0; x <= b.x1; x++) {
          if (sight.art[y * GRID + x] === EMPTY) {
            damage[i] = BLOCK * BAND_H;
            break;
          }
        }
      }
    }

    const worst = [...damage]
      .map((n, i) => ({ n, i }))
      .filter((d) => d.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
    if (worst.length === 0) break;

    await studio.aim();
    // Second choice, then third, and so on down the survey's ranking. No memory
    // beyond the canvas and no backtracking, so it gets stuck.
    for (const { i } of worst) {
      await studio.paint(i, choose(cost, i, siblings(sight.art, i), round + 1));
    }
    events = await studio.attested(events);
  }

  return false;
}

/** The swatch channel, read the way a player reads it: which swatch is buzzing. */
async function hotHues(page: Page): Promise<string[]> {
  const hot: string[] = [];
  for (let h = 0; h < HUE_COUNT; h++) {
    const swatch = page.getByRole("button", { name: new RegExp(`^${hueName(h)},`) });
    const label = (await swatch.first().getAttribute("aria-label")) ?? "";
    if (label.includes("something is off")) hot.push(hueName(h));
  }
  return hot;
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

/** Take the next rung: from the solved dialog if there is one, otherwise by
 *  walking away from the board, which the server makes you wait 60s to do. */
async function advance(studio: Studio, page: Page): Promise<void> {
  const nextRung = page.getByRole("button", { name: "Next rung" });
  if (await visible(nextRung)) {
    await nextRung.click();
    await page.getByRole("application", { name: /painting grid$/ }).waitFor({ timeout: 60_000 });
    return;
  }

  const was = await studio.rung();
  const abandon = page.getByRole("button", { name: "Abandon this board" });
  const deadline = Date.now() + 150_000;
  for (;;) {
    await abandon.click();
    await page.waitForTimeout(3000);
    if ((await studio.rung()) !== was) return;
    if (Date.now() > deadline) throw new Error("could not move off this rung");
    // 429 until the board has been held a minute. Nothing to do but wait it out.
    await page.waitForTimeout(10_000);
  }
}

async function main() {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: !HEADED });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

    // Every request below is the page's. Counting them is how you check that
    // the page is still attesting for you, which is what makes a solve bankable.
    const calls = new Map<string, number>();
    page.on("response", (r) => {
      const p = new URL(r.url()).pathname;
      if (!p.startsWith("/api/")) return;
      const k = `${p} ${r.status()}`;
      calls.set(k, (calls.get(k) ?? 0) + 1);
    });

    await page.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
    await register(page);
    await vouched(page);

    const studio = new Studio(page);
    let banked = 0;
    for (let n = 0; n < PUZZLES; n++) {
      const landed = await firstOf(
        page,
        {
          grid: studio.grid(),
          idle: page.getByRole("button", { name: "Take the next puzzle" }),
        },
        60_000,
      );
      if (landed === "idle") {
        await page.getByRole("button", { name: "Take the next puzzle" }).click();
        await studio.grid().waitFor({ timeout: 60_000 });
      }

      if (await playOne(studio, page)) banked++;
      if (n < PUZZLES - 1) await advance(studio, page);
    }

    console.log(`\n${banked} of ${PUZZLES} banked.`);
    for (const [k, n] of [...calls].sort()) console.log(`  ${n.toString().padStart(4)} × ${k}`);
  } finally {
    await browser?.close();
  }
}

await main();
