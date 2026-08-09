/**
 * pixe-watchdog.ts — the stop gate for pixe benchmark runs.
 *
 * Loaded by run-pixe.sh via `-e`, next to pixe-meter.ts. One job: when the
 * model stops talking and the session would otherwise end, ask it to
 * confirm — once, neutrally, and with no information it did not already have:
 *
 *     "Are you sure you want to stop? …reply with exactly the single word
 *      ABANDON to confirm…"
 *
 * The wording is the policy. The probe must not say how many puzzles remain,
 * how far the ladder goes, or that stopping is "early" — a model goaded with
 * "you have more to do" is being steered, and a steered run measures the
 * steering. The only fact the probe adds is that stopping is final, which the
 * solver prompt already said. If the model answers with the word ABANDON, the
 * run is over and that is the final score. Anything else and it has, by its
 * own choice, kept going.
 *
 * Why this exists at all: an agent loop ends whenever the model emits a
 * message with no tool calls. Models do this by accident — a summary turn, a
 * "let me take stock" beat with no action attached — and in --print mode that
 * accident silently ends a benchmark run that had hours left in it. The gate
 * turns "stopped talking" from an ending into a question.
 *
 * The hook is `agent_end`, not `agent_settled`, and the delivery is
 * `followUp`, and both halves are load-bearing. In --print mode pi resolves
 * the prompt and disposes the whole session the moment the run settles, so by
 * `agent_settled` the extension's handle is already invalidated (verified
 * against pi 0.84.1 — a probe from there dies with a stale-ctx error). At
 * `agent_end` the run machinery is still live, and a queued follow-up counts
 * as a continuation, so the session never settles and print mode stays
 * running. The cost of the earlier hook is that `agent_end` also fires on
 * runs pi intends to recover itself, which is what the stopReason check below
 * is for.
 *
 * The outcome is written to $PIXE_WORKDIR/watchdog.json so the shell half of
 * the runner (the relaunch loop in run-pixe.sh) can tell a deliberate ending
 * — ABANDON confirmed, ladder complete, model unresponsive — from a process
 * that merely died and should be relaunched.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROBE =
  "Are you sure you want to stop? If so, reply with exactly the single word " +
  "ABANDON to confirm — the run ends and its score is final. Otherwise, carry on.";

/**
 * Consecutive runs in which the model was probed and then stopped again
 * without executing a single tool. Three of those in a row is not a model
 * mid-thought, it is a model answering the same question with inaction; at
 * that point the gate stops holding the door and lets the session end, and
 * the shell treats it as final rather than relaunching into the same wall.
 */
const MAX_IDLE_PROBES = 3;

function writeOutcome(outcome: "abandoned" | "complete" | "unresponsive") {
  try {
    const dir = process.env.PIXE_WORKDIR || process.cwd();
    writeFileSync(join(dir, "watchdog.json"), JSON.stringify({ outcome, at: Date.now() }, null, 2));
  } catch {
    // The gate must never take down the run; a missing marker only costs the
    // shell one redundant completeness check.
  }
}

/**
 * Whether the ladder is actually finished, from the server's mouth. The GET
 * run-state endpoint reports `complete: true` once every rung is banked
 * (server/runs.ts); a run in that state has nothing left to be probed toward.
 * Errors count as "not complete" — a probe against a finished ladder is
 * harmless, a missed probe against an unfinished one is a lost run.
 */
async function runComplete(): Promise<boolean> {
  const api = process.env.PIXE_API;
  const id = process.env.PIXE_RUN_ID;
  const token = process.env.PIXE_RUN_TOKEN;
  if (!api || !id || !token) return false;
  try {
    const resp = await fetch(`${api}/api/bench/runs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { complete?: boolean };
    return body.complete === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let everProbed = false;
  let workSinceProbe = false;
  let idleProbes = 0;
  let done = false;

  pi.on("tool_execution_start", () => {
    workSinceProbe = true;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (done) return;

    const last = [...event.messages]
      .reverse()
      .find((m): m is typeof m & { role: "assistant" } => m.role === "assistant") as
      | { content: unknown; stopReason?: string }
      | undefined;

    // A run that ended in an error or an abort is not the model deciding to
    // stop, and a question is not the fix for it. Stay out of the way: pi's
    // own retry may recover it, and if the process dies instead, the relaunch
    // loop in run-pixe.sh resumes the run in a fresh session.
    if (!last || last.stopReason === "error" || last.stopReason === "aborted") return;

    const text = Array.isArray(last.content)
      ? last.content
          .filter((block): block is { type: "text"; text: string } => block?.type === "text")
          .map((block) => block.text)
          .join("\n")
      : String(last.content ?? "");

    // ABANDON only counts as an answer to the question. Before the first
    // probe the word has never been asked for, and matching it then would
    // end runs on an incidental mention. Case-sensitive and whole-word for
    // the same reason: the protocol's own /abandon endpoint and the solver's
    // narration about abandoning boards are lowercase.
    if (everProbed && /\bABANDON\b/.test(text)) {
      done = true;
      writeOutcome("abandoned");
      console.error("  [stop gate] ABANDON confirmed — the run is final");
      if (ctx.hasUI) ctx.ui.notify("pixe-watchdog: ABANDON confirmed — the run is final", "info");
      return;
    }

    if (await runComplete()) {
      done = true;
      writeOutcome("complete");
      console.error("  [stop gate] ladder complete");
      return;
    }

    if (everProbed && !workSinceProbe) {
      idleProbes += 1;
      if (idleProbes >= MAX_IDLE_PROBES) {
        done = true;
        writeOutcome("unresponsive");
        console.error("  [stop gate] no work after repeated probes — letting the run end");
        if (ctx.hasUI) ctx.ui.notify("pixe-watchdog: no work after repeated probes — letting the run end", "info");
        return;
      }
    } else {
      idleProbes = 0;
    }

    everProbed = true;
    workSinceProbe = false;
    console.error("  [stop gate] model stopped — asking it to confirm");
    pi.sendUserMessage(PROBE, { deliverAs: "followUp" });
  });
}
