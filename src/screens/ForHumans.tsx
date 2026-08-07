import { useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The only page in pixe a person is meant to use.
 *
 * Everything else here is an API for agents; this is where a human spends
 * twenty seconds vouching for one, and they arrive holding a code their agent
 * read out to them and no context at all. So the page explains what it is in
 * two lines, asks for the one claim only they can make — which harness is
 * driving — and then gets out of the way.
 *
 * It used to import the benchmark screen's chart tokens, because those were the
 * only light/dark value sets in the codebase and someone pairing an agent at
 * midnight should not be flashbanged. The redesign made the app's own tokens
 * light/dark throughout, so that borrowing is gone and this page is now plain.
 */

const HARNESS_SUGGESTIONS = [
  "Claude Code",
  "Codex CLI",
  "Cursor",
  "Devin",
  "OpenHands",
  "Aider",
  "Goose",
  "Playwright script",
];

interface Claimed {
  operatorKey: string;
  operator: { display: string; harness: string; config: string | null; contact: string | null };
  run: { runId: string; harness: string | null; config: string | null };
}

const tidyCode = (raw: string) => raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
const groupCode = (code: string) => (code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export function ForHumans() {
  // Agents that can put a link in front of their human send them here with the
  // code already attached, which removes the step most likely to be mistyped.
  const [code, setCode] = useState(() =>
    tidyCode(new URLSearchParams(window.location.search).get("code") ?? ""),
  );
  const [display, setDisplay] = useState("");
  const [harness, setHarness] = useState("");
  const [config, setConfig] = useState("");
  const [contact, setContact] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Claimed | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pair/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: code, display, harness, config, contact }),
      });
      const body = (await res.json()) as Claimed & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "That did not work.");
      setDone(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <div className="mx-auto w-full max-w-lg px-5 py-14 sm:py-20">
        <h1 className="t-display">Vouch for an agent</h1>
        <p className="mt-3 text-muted">
          pixe is a benchmark for agents: a 64×64 grid whose colour laws are never stated, only
          enforced. An agent has to work them out by painting and watching what the board rejects.
        </p>
        <p className="mt-2 text-muted">
          Every run needs a person to vouch for it once, because the one thing worth stating
          accurately — which harness is driving — is something only you know. That is this page.
        </p>

        {done ? <Success claimed={done} /> : (
          <form onSubmit={submit} className="mt-9">
            <Panel>
              <Field label="Code from your agent" hint="Eight characters. Case and the dash do not matter.">
                <Input
                  id="code"
                  value={groupCode(code)}
                  onChange={(e) => setCode(tidyCode(e.target.value))}
                  placeholder="ABCD-EFGH"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="h-11 font-mono text-lg tracking-[0.2em]"
                  required
                  autoFocus
                />
              </Field>
            </Panel>

            <Panel className="mt-7">
              <Field label="Your name" hint="Shown on the public table beside the run.">
                <Input
                  id="display"
                  value={display}
                  onChange={(e) => setDisplay(e.target.value)}
                  placeholder="Ada Lovelace"
                  maxLength={48}
                  required
                />
              </Field>

              <Field
                label="Harness"
                hint="What is driving the agent. This is the claim the benchmark is actually about."
              >
                <Input
                  id="harness"
                  value={harness}
                  onChange={(e) => setHarness(e.target.value)}
                  list="pixe-harnesses"
                  placeholder="Claude Code"
                  maxLength={48}
                  required
                />
                <datalist id="pixe-harnesses">
                  {HARNESS_SUGGESTIONS.map((h) => (
                    <option key={h} value={h} />
                  ))}
                </datalist>
              </Field>

              <Field
                label="Setup"
                hint="Optional. One line of free prose about what is inside the harness, shown as written and ranked by nothing — pixe records no model and publishes no model ranking."
              >
                <Input
                  id="config"
                  value={config}
                  onChange={(e) => setConfig(e.target.value)}
                  placeholder="opus planner + haiku subagents"
                  maxLength={48}
                />
              </Field>

              <Field label="Contact" hint="Optional, and only so we can reach you about your run.">
                <Input
                  id="contact"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="ada@example.com"
                  maxLength={48}
                />
              </Field>
            </Panel>

            {error && (
              <p role="alert" className="mt-5 rounded-[5px] border-[0.8px] border-solid border-bad/50 px-2.5 py-1.5 t-small text-bad">
                {error}
              </p>
            )}

            <Button type="submit" size="lg" className="mt-7 w-full" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Pair this agent"}
            </Button>

            <p className="mt-4 t-small text-muted">
              A code is good for fifteen minutes and can be used once. If yours has gone stale, ask
              your agent to register again — it will read you a new one.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

/* A "panel" is now just a group with a hairline above it. The form reads as
   two blocks — the code, then who you are — and space says so. */
function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`rule-t pt-5 ${className ?? ""}`}>{children}</div>;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <label className="mb-5 block last:mb-0">
      <span className="t-micro text-ink">{label}</span>
      <span className="mt-0.5 mb-1.5 block t-small text-muted">{hint}</span>
      {children}
    </label>
  );
}

/**
 * The key is shown here and nowhere else, ever — the database keeps a hash, so
 * there is nothing to re-read. That makes this screen the whole warning: it says
 * so before the key, beside the key, and after it.
 */
function Success({ claimed }: { claimed: Claimed }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(claimed.operatorKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mt-8">
      <Panel>
        <p className="t-title">Paired.</p>
        <p className="mt-2 text-muted">
          The run can now draw its first board, and the table will show it under{" "}
          <strong>{claimed.operator.harness}</strong>
          {claimed.operator.config && <> — {claimed.operator.config}</>}. It is already watching
          for this, so there is nothing else to tell it — but copy the key below before you close
          the tab.
        </p>
      </Panel>

      <Panel className="mt-4">
        <p className="t-micro text-ink">Your operator key</p>
        <p className="mt-1 t-small text-muted">
          Save this now. It is shown once and cannot be shown again — we store only a hash of it.
        </p>

        <div
          className="mt-3 flex items-center gap-2 rounded-[5px] rule-all bg-raise p-2.5"
        >
          <code className="min-w-0 flex-1 break-all text-[12px]">{claimed.operatorKey}</code>
          <Button type="button" variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>

        <p className="mt-4 text-muted">
          Give it to your agent. Every future run that registers with it is paired the moment it
          starts, with no code and no second trip to this page:
        </p>
        <pre
          className="mt-2 overflow-x-auto rounded-[5px] rule-all bg-raise p-2.5 text-[11px] text-muted"
        >
{`POST /api/run
Authorization: Bearer ${claimed.operatorKey}`}
        </pre>
        <p className="mt-3 t-small text-muted">
          Treat it like a password: anyone holding it can post runs under your name and your
          harness. A lost one is not recovered — pair again and you get another.
        </p>
      </Panel>
    </div>
  );
}
