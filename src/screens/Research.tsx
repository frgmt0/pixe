import { ExternalLink } from "lucide-react";
import { HUES } from "@shared/palette";

/**
 * The "what is this actually measuring" screen. The Guide tells you how to
 * point an agent at the API; this page is for the reader who wants to know
 * why the benchmark is shaped the way it is before they spend tokens on it —
 * what the loop looks like, what the ranked numbers mean, and what kinds of
 * law a board can hide, drawn small enough for a human to actually see.
 *
 * The figures are all hand-placed miniatures, 8×8 where the real board is
 * 64×64. They demonstrate categories, not answers: every real law is
 * generated fresh per run, so there is nothing here a solver could crib.
 */
export function Research() {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24">
      <header className="rule-b pt-2 pb-7">
        <h1 className="t-display">Research</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          What is left to measure once a model has read the entire internet? If the test set
          is somewhere in the training data, is a high score comprehension, or memory? pixe is
          a bet on a third option: measure the act of figuring something out, on puzzles whose
          rules could not have been memorised because they did not exist until the run began.
        </p>
      </header>

      <section className="mt-9">
        <h2 className="t-title mb-2">The shape of the game</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          A 64×64 grid, eight colours, 4096 cells. Every board hides its own laws about which
          colours may go where and which may sit next to each other, and the agent is told
          none of them — no rule text, no hint endpoint, no examples. The protocol document
          puts it plainly: <Q>submitting is also how you observe</Q>. A grid that fails is not
          an error, in other words, but a measurement — it comes back with complaints
          attached, and those complaints are the only teacher there is. The agent paints,
          the board objects, and the laws take shape one refusal at a time.
        </p>
        <p className="mt-4 text-[14px] leading-relaxed text-muted">
          The board only ever complains through two channels, and everything an agent will
          ever learn arrives through one of them.
        </p>

        <div className="mt-6 grid gap-8 sm:grid-cols-2">
          <Figure
            caption="Flashes point at cells. Something about these two placements breaks a law; which law is the agent's problem."
          >
            <MiniGrid
              rows={[
                "..0.....",
                ".....2..",
                "3...5...",
                "..2...0.",
                ".5......",
                "....3..5",
                ".0......",
                "......2.",
              ]}
              flash={[
                [3, 6],
                [5, 7],
              ]}
            />
          </Figure>
          <Figure
            caption="Buzzes name colours. A counting law about Banana is failing somewhere — no cell is pointed at, only the swatch."
          >
            <div className="flex h-full flex-col justify-center gap-4">
              <MiniGrid
                rows={[
                  "........",
                  "..2.....",
                  ".....2..",
                  "........",
                  "...5....",
                  ".2......",
                  "........",
                  "......0.",
                ]}
              />
              <Swatches buzz={[2]} />
            </div>
          </Figure>
        </div>

        <p className="mt-6 text-[14px] leading-relaxed text-muted">
          One more property does a great deal of quiet work: an unfinished counting law stays
          silent while blanks remain, but on a full grid no failing law is invisible.{" "}
          <Q>Once a grid is full, silence means solved</Q> — which means a full, quiet board
          is a proof, not a guess, and an empty board tells you nothing at all (probing with
          one is a wasted request).
        </p>
      </section>

      <section className="rule-t mt-10 pt-7">
        <h2 className="t-title mb-2">What the number means</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          There are two readings of any leaderboard. The first is that it ranks how much a
          model knows — which is the reading benchmarks like MMLU invite, and the reading
          contamination slowly hollows out. The second is that it ranks how well a model
          converts evidence into belief: how few experiments it needs, and how fast it moves,
          to pin down a rule it has never seen. Because every pixe law is generated fresh at
          registration, the first reading is simply unavailable here — there was nothing to
          have known — and I am inclined to trust what is left.
        </p>
        <p className="mt-4 text-[14px] leading-relaxed text-muted">
          So the two ranked columns are exactly those two quantities. <Term>Probes per
          solve</Term> counts rejected submissions — every one an experiment the agent chose
          to run — so a low number is an agent that thinks before it paints, and a high
          number is an agent fishing. <Term>Effective time per solve</Term> is wall-clock
          from issue to acceptance, kept server-side, with abandoned boards charged to the
          numerator and nothing added to the denominator (giving up costs you; it is
          occasionally still right). Token counts and dollar costs appear on the table too,
          but they are declared by the run and ranked by nothing — the server can keep an
          honest clock, and it refuses to pretend it can audit anyone's invoice.
        </p>
      </section>

      <section className="rule-t mt-10 pt-7">
        <h2 className="t-title mb-2">The kinds of laws</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          The generator draws from a menu of law families, and by the upper ladder a single
          board carries several at once, interacting. The families group into four broad
          kinds, shown here at miniature scale. (A model could read this page too, of course.
          Nothing here shortens a single deduction, which is rather the point.)
        </p>

        <div className="mt-6 grid gap-8 sm:grid-cols-2">
          <Figure
            title="Placement"
            caption="Where a colour may sit: rows, columns, regions, diagonals. Here Blueberry belongs to the left half of the board, and one stray flashes."
          >
            <MiniGrid
              rows={[
                "5...2...",
                ".5......",
                "..3....0",
                "5....5..",
                ".2......",
                "..5....2",
                "0.......",
                ".5....3.",
              ]}
              flash={[[3, 5]]}
            />
          </Figure>

          <Figure
            title="Adjacency"
            caption="Who may touch whom, orthogonally or diagonally. Say Tomato may never touch Blueberry: the one place they meet, both cells flash."
          >
            <MiniGrid
              rows={[
                "0.......",
                "...2....",
                ".0......",
                "...05...",
                "......2.",
                ".5......",
                "....0...",
                ".......5",
              ]}
              flash={[
                [3, 3],
                [3, 4],
              ]}
            />
          </Figure>

          <Figure
            title="Counting"
            caption="How many of a colour the whole board may hold — exact totals, parities, caps, ratios between colours. The board never says which; it only buzzes the colours implicated."
          >
            <div className="flex h-full flex-col justify-center gap-4">
              <MiniGrid
                rows={[
                  "..2.....",
                  ".....3..",
                  "2.......",
                  "....2...",
                  ".3......",
                  "......2.",
                  "...3....",
                  "2.......",
                ]}
              />
              <Swatches buzz={[2, 3]} />
            </div>
          </Figure>

          <Figure
            title="Structure"
            caption="Global shape: mirror symmetries, connected regions, reachability. This board wants left–right symmetry, and a single broken reflection flashes."
          >
            <MiniGrid
              rows={[
                "2......2",
                ".5....5.",
                "..0..0..",
                "3......3",
                ".2....6.",
                "..5..5..",
                "0......0",
                ".3....3.",
              ]}
              flash={[[4, 6]]}
            />
          </Figure>
        </div>

        <p className="mt-8 text-[14px] leading-relaxed text-muted">
          Deeper in the ladder, rungs stop being one board at all. A multi-phase rung hands
          you a second board the moment the first is accepted, and the second board's laws
          are derived from the grid you just painted — your own accepted solution becomes the
          seed of the next problem, with some of its cells carried over and locked in place.
          Whatever the agent learned about phase one is now evidence about phase two, if it
          can work out the relationship.
        </p>

        <div className="mt-6">
          <Figure caption="A two-phase rung: the accepted first board seeds the second board's laws, and the hatched cells arrive locked — inherited, immovable, and silently load-bearing.">
            <div className="flex flex-wrap items-center gap-4">
              <MiniGrid
                rows={[
                  "02253105",
                  "25310522",
                  "31052253",
                  "05225310",
                  "22531052",
                  "53105225",
                  "10522531",
                  "22053105",
                ]}
              />
              <span className="t-num text-muted" aria-hidden>
                →
              </span>
              <MiniGrid
                rows={[
                  "........",
                  ".5......",
                  "....2...",
                  "........",
                  "..0.....",
                  "......3.",
                  "........",
                  "....5...",
                ]}
                locked={[
                  [1, 1],
                  [2, 4],
                  [4, 2],
                  [5, 6],
                  [7, 4],
                ]}
              />
            </div>
          </Figure>
        </div>
      </section>

      <section className="rule-t mt-10 pt-7">
        <h2 className="t-title mb-2">Why 500, and why so hard</h2>
        <p className="text-[14px] leading-relaxed text-muted">
          The ladder is 500 rungs, tiered so that the early boards teach the loop and the
          late boards are frankly hostile — several interacting laws, multiple phases, rules
          obscure enough that a human working by hand has no realistic path through them
          (watching a run crawl the feedback loop, I am inclined to think human patience
          gives out well before rung fifty). By capping the ladder at a number a run could
          conceivably finish, the
          benchmark keeps a finish line on the board while betting that nothing reaches it
          soon, whereas an open-ended ladder would only ever measure who gave up latest.
          Every solve streams to the leaderboard the moment it is banked, so a run in
          progress is a run you can watch.
        </p>
      </section>

      <section className="rule-t mt-8 pt-7 pb-2">
        <h2 className="t-title mb-3">Read more</h2>
        <ul className="space-y-2">
          <ResearchLink href="/agents.txt">
            <code className="t-num">/agents.txt</code> — the whole protocol, plain text
          </ResearchLink>
          <ResearchLink href="https://github.com/frgmt0/pixe">
            github.com/frgmt0/pixe — the generator, the server, and the runner
          </ResearchLink>
        </ul>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Figures                                                             */
/* ------------------------------------------------------------------ */

const EMPTY_CH = ".";

/**
 * An 8×8 demonstration board. `rows` is eight strings of eight characters,
 * digit = hue id, dot = empty. Flashed cells get a pulsing ring in the hue's
 * own dark edge colour — the same convention the real violation rings used —
 * and locked cells get a hatch overlay.
 */
function MiniGrid({
  rows,
  flash = [],
  locked = [],
}: {
  rows: string[];
  flash?: [number, number][];
  locked?: [number, number][];
}) {
  const isFlagged = (list: [number, number][], r: number, c: number) =>
    list.some(([fr, fc]) => fr === r && fc === c);

  return (
    <div className="inline-grid grid-cols-8 gap-px rounded-[3px] bg-sunk p-1" aria-hidden>
      {rows.flatMap((row, r) =>
        [...row].map((ch, c) => {
          const hue = ch === EMPTY_CH ? null : HUES[Number(ch)]!;
          const flashed = isFlagged(flash, r, c);
          const isLocked = isFlagged(locked, r, c);
          return (
            <span
              key={`${r}-${c}`}
              className="relative size-4"
              style={{ backgroundColor: hue ? hue.hex : "transparent" }}
            >
              {flashed && (
                <span
                  className="absolute -inset-0.5 z-10 animate-pulse border-2"
                  style={{ borderColor: hue ? hue.dark : "var(--color-ink)" }}
                />
              )}
              {isLocked && (
                <span
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(45deg, transparent 0 2px, color-mix(in srgb, var(--color-ink) 45%, transparent) 2px 4px)",
                  }}
                />
              )}
            </span>
          );
        }),
      )}
    </div>
  );
}

/** The eight swatch chips; the buzzed ones ring and name themselves. */
function Swatches({ buzz = [] }: { buzz?: number[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {HUES.map((h) => {
        const buzzed = buzz.includes(h.id);
        return (
          <span
            key={h.id}
            className={`flex items-center gap-1 rounded-[3px] px-1 py-0.5 ${buzzed ? "animate-pulse" : ""}`}
            style={buzzed ? { boxShadow: `inset 0 0 0 1.5px ${h.dark}` } : undefined}
            title={h.name}
          >
            <span className="size-2.5" style={{ backgroundColor: h.hex }} />
            {buzzed && <span className="t-micro text-ink">{h.name}</span>}
          </span>
        );
      })}
    </div>
  );
}

function Figure({
  title,
  caption,
  children,
}: {
  title?: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="flex flex-col gap-3">
      {title && <p className="t-lead">{title}</p>}
      {children}
      <figcaption className="t-micro max-w-xs text-muted">{caption}</figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */

function Q({ children }: { children: React.ReactNode }) {
  return <span className="text-ink">“{children}”</span>;
}

function Term({ children }: { children: React.ReactNode }) {
  return <span className="text-ink">{children}</span>;
}

function ResearchLink({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  return (
    <li>
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer" : undefined}
        className="inline-flex items-center gap-1.5 text-muted underline underline-offset-4 hover:text-ink"
      >
        {children}
        {external && <ExternalLink className="size-3" strokeWidth={1.75} />}
      </a>
    </li>
  );
}
