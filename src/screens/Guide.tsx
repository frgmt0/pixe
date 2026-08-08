import { ExternalLink } from "lucide-react";

/**
 * The "how to run this yourself" screen. There used to be a page here that
 * played the puzzle in a browser; there is no browser step left to document.
 * What is left to explain is the one that actually measures something: point
 * an agent at the API and let the server keep the clock.
 *
 * Same register as the rest of the site — a title, a hairline, short
 * sections, no cards, no screenshots of a UI that no longer exists.
 */
export function Guide() {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24">
      <header className="rule-b pt-2 pb-7">
        <h1 className="t-display">Run it yourself</h1>
        <p className="mt-3 max-w-xl text-muted">
          pixe measures agentic deduction across a ladder of 500 64×64 puzzles — small enough
          to finish, and hard enough that nothing has yet. Every board hides its own laws about
          which colours may go where and which may sit next to each other, and the agent is
          never told any of them — it infers the rules purely from what the API says is wrong.
          There is no browser in the loop: registration, issuing, answering and abandoning are
          all JSON over HTTP, and every clock is kept server-side, from the moment a puzzle is
          issued to the moment a grid is accepted.
        </p>
      </header>

      <ol className="mt-8 space-y-9">
        <Step n={1} title="Clone the repo">
          <p className="text-muted">
            The runner script and the reference solver live alongside the server and the
            benchmark site.
          </p>
          <CodeBlock>{`git clone https://github.com/frgmt0/pixe\ncd pixe`}</CodeBlock>
        </Step>

        <Step n={2} title="Install pi">
          <p className="text-muted">
            <a
              href="https://pi.dev"
              target="_blank"
              rel="noreferrer"
              className="text-ink underline underline-offset-4 hover:no-underline"
            >
              pi
            </a>{" "}
            is what drives the model against the API — it holds the run open, calls your
            provider, and submits the grids it decides on.
          </p>
        </Step>

        <Step n={3} title="Export your provider's API key">
          <p className="text-muted">
            Whatever key <code className="t-num text-ink">pi</code> needs to reach your
            provider, in your shell's usual variable.
          </p>
          <CodeBlock>{`export ANTHROPIC_API_KEY=sk-...`}</CodeBlock>
        </Step>

        <Step n={4} title="Run it">
          <p className="text-muted">
            One command starts a run, registers it under the model and provider you name, and
            begins solving.
          </p>
          <CodeBlock>{`./run-pixe.sh --provider anthropic --model claude-opus-5`}</CodeBlock>
          <p className="mt-4 mb-1.5 t-micro text-muted">A few provider examples</p>
          <CodeBlock>{[
            "./run-pixe.sh --provider anthropic   --model claude-opus-5",
            "./run-pixe.sh --provider openai       --model gpt-5.1",
            "./run-pixe.sh --provider openrouter    --model qwen/qwen3-max",
            "./run-pixe.sh --provider ollama        --model llama3.3",
          ].join("\n")}</CodeBlock>
        </Step>
      </ol>

      <section className="rule-t mt-10 pt-7">
        <h2 className="t-title mb-2">What happens next</h2>
        <p className="max-w-xl text-muted">
          Solves stream straight to the leaderboard as they're banked — there is no review
          step and no delay. Every run shown there is{" "}
          <span className="text-ink">unverified by default</span>: the model, provider and
          setup note are whatever the run declared at registration, and nothing checks them.
          The only runs marked verified are the ones executed on the maintainer's own machine.
          Time, request counts and solve validity are the only things the server itself
          measures; everything else on the table is self-reported.
        </p>
      </section>

      <section className="rule-t mt-8 pt-7 pb-2">
        <h2 className="t-title mb-3">Read more</h2>
        <ul className="space-y-2">
          <GuideLink href="/agents.txt">
            <code className="t-num">/agents.txt</code> — the whole protocol, plain text
          </GuideLink>
          <GuideLink href="https://github.com/frgmt0/pixe">
            github.com/frgmt0/pixe — the repository, including{" "}
            <code className="t-num">docs/RUNNER.md</code>
          </GuideLink>
        </ul>
      </section>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="t-num mt-0.5 shrink-0 text-muted">{String(n).padStart(2, "0")}</span>
      <div className="min-w-0 flex-1">
        <h2 className="t-lead mb-1.5">{title}</h2>
        {children}
      </div>
    </li>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="table-scroll scrollbar-slim rule-all mt-3 rounded-[5px] bg-sunk px-3.5 py-3 text-[12px] leading-relaxed text-ink">
      <code>{children}</code>
    </pre>
  );
}

function GuideLink({ href, children }: { href: string; children: React.ReactNode }) {
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
