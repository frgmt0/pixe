/**
 * pixe-meter.ts — usage metering for pixe benchmark runs.
 *
 * Loaded by run-pixe.sh via `-e`. One job, entirely local to this pi process:
 * track token/cost usage and publish it per puzzle, because pixe's submit
 * endpoint accepts an optional, self-reported `meter: { tokensIn, tokensOut,
 * costMicro }` object and the server keeps it *per puzzle* — only the value
 * attached to the submit that finally accepts a rung is stored (server/
 * runs.ts, postSubmit; phase handoffs and probes never persist `meter`).
 * Reporting the whole-session running total on every puzzle would make every
 * puzzle after the first look like it cost the entire run so far, so this
 * extension tracks a cumulative total plus a per-puzzle baseline and exposes
 * the difference through a `pixe_meter` tool and `meter.json` in the workdir.
 *
 * WHAT THIS FILE DELIBERATELY NO LONGER DOES: enforce the 250K context cap
 * by calling ctx.compact(). That was tried, and it kills headless runs: pi's
 * compact() begins with an unconditional abort of the in-flight agent run
 * (agent-session compact() → await this.abort()) and never restarts it, so
 * in --print mode the run ends "This operation was aborted", exit 1 —
 * observed live on 2026-08-09, one process death per 250K crossing. The cap
 * is now enforced by run-pixe.sh writing `compaction.reserveTokens` into the
 * workdir's project settings, which moves the trigger of pi's own overflow
 * compaction down to the cap — and pi's native path compacts and *retries*,
 * mid-run, without dropping anything. Do not reintroduce ctx.compact() here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

interface Totals {
  tokensIn: number;
  tokensOut: number;
  costMicro: number;
}

const zeroTotals = (): Totals => ({ tokensIn: 0, tokensOut: 0, costMicro: 0 });

function addUsage(totals: Totals, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } | undefined) {
  if (!usage) return;
  // "tokens in" = everything that was prompt rather than generation: fresh
  // input plus both cache tiers. "tokens out" = generated tokens (reasoning
  // is already a subset of output per pi's Usage type, so it is not added
  // twice).
  totals.tokensIn += usage.input + usage.cacheRead + usage.cacheWrite;
  totals.tokensOut += usage.output;
  totals.costMicro += Math.round(usage.cost.total * 1e6);
}

function meterPath(): string {
  const dir = process.env.PIXE_WORKDIR || process.cwd();
  return join(dir, "meter.json");
}

function writeMeter(cumulative: Totals, baseline: Totals) {
  const puzzle: Totals = {
    tokensIn: Math.max(0, cumulative.tokensIn - baseline.tokensIn),
    tokensOut: Math.max(0, cumulative.tokensOut - baseline.tokensOut),
    costMicro: Math.max(0, cumulative.costMicro - baseline.costMicro),
  };
  const payload = {
    // Whole-session cumulative, for reference / debugging only. Do NOT put
    // this on the wire as-is once more than one puzzle has been solved.
    tokensIn: cumulative.tokensIn,
    tokensOut: cumulative.tokensOut,
    costMicro: cumulative.costMicro,
    // Cumulative since the last pixe_meter "reset_puzzle" call. THIS is what
    // belongs in the submit body's `meter` field.
    puzzleTokensIn: puzzle.tokensIn,
    puzzleTokensOut: puzzle.tokensOut,
    puzzleCostMicro: puzzle.costMicro,
    updatedAt: Date.now(),
  };
  try {
    const dir = process.env.PIXE_WORKDIR || process.cwd();
    mkdirSync(dir, { recursive: true });
    writeFileSync(meterPath(), JSON.stringify(payload, null, 2));
  } catch {
    // Metering must never take down the run. A run that fails to write
    // meter.json is still a run; it just reports two blank columns.
  }
}

export default function (pi: ExtensionAPI) {
  const cumulative = zeroTotals();
  let puzzleBaseline = zeroTotals();

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      addUsage(cumulative, event.message.usage);
    } else if (event.message.role === "toolResult" && event.message.usage) {
      // Nested LLM work done inside a tool call, counted the same way pi's
      // own session totals count it.
      addUsage(cumulative, event.message.usage);
    }
    writeMeter(cumulative, puzzleBaseline);
  });

  // Compaction summaries cost tokens too, and pi counts them in session
  // totals — so a meter that wants to match pi's own footer must as well.
  // With the cap enforced through reserveTokens this now fires on pi's own
  // native compactions; the stderr line keeps the operator's status stream
  // honest about where those tokens went.
  pi.on("session_compact", (event) => {
    console.error("  [meter] context compacted");
    if (event.compactionEntry.usage) {
      addUsage(cumulative, event.compactionEntry.usage);
      writeMeter(cumulative, puzzleBaseline);
    }
  });

  pi.registerTool({
    name: "pixe_meter",
    label: "pixe meter",
    description:
      "Read or reset the pixe token/cost meter. The pixe server stores `meter` per puzzle (only the value on the " +
      "submit that finally accepts a rung is kept), so call this with reset_puzzle right after a new puzzle starts " +
      "(a /next response, or a next payload inside an accept response) and with read before every submit for that " +
      "puzzle. read returns the exact object to send as the `meter` field.",
    promptSnippet: "Read or reset the pixe per-puzzle token/cost meter",
    promptGuidelines: [
      "Call pixe_meter with reset_puzzle immediately whenever a new pixe puzzle starts (a /next response, or a " +
        "`next` payload inside an accepted submit), before doing anything else with it.",
      "Call pixe_meter with read right before every pixe submit request and put its tokensIn/tokensOut/costMicro " +
        "verbatim into that request's `meter` field.",
    ],
    parameters: Type.Object({
      action: StringEnum(["read", "reset_puzzle"] as const, {
        description:
          "'read' returns cumulative tokens/cost for the puzzle held since the last reset_puzzle (what to submit). " +
          "'reset_puzzle' zeroes that counter — call it once per new puzzle.",
      }),
    }),
    async execute(_toolCallId, params) {
      if (params.action === "reset_puzzle") {
        puzzleBaseline = { ...cumulative };
        writeMeter(cumulative, puzzleBaseline);
        return {
          content: [
            {
              type: "text",
              text: "Puzzle meter reset. meter for the next submit should be {\"tokensIn\":0,\"tokensOut\":0,\"costMicro\":0} until more usage accrues.",
            },
          ],
          details: {},
        };
      }

      const puzzle: Totals = {
        tokensIn: Math.max(0, cumulative.tokensIn - puzzleBaseline.tokensIn),
        tokensOut: Math.max(0, cumulative.tokensOut - puzzleBaseline.tokensOut),
        costMicro: Math.max(0, cumulative.costMicro - puzzleBaseline.costMicro),
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ tokensIn: puzzle.tokensIn, tokensOut: puzzle.tokensOut, costMicro: puzzle.costMicro }),
          },
        ],
        details: { cumulative, puzzle },
      };
    },
  });
}
