/**
 * pixe-meter.ts — metering and context-cap enforcement for pixe benchmark runs.
 *
 * Loaded by run-pixe.sh via `-e`. Two jobs, both entirely local to this pi
 * process; neither talks to the pixe API:
 *
 * 1. CONTEXT CAP. pi already auto-compacts at `contextWindow - reserveTokens`
 *    (see docs/compaction.md), which is correct and left alone. That trigger
 *    is per-model and can sit well above the benchmark's own budget on
 *    huge-window models, so this extension adds a second, lower trigger: if
 *    live context ever exceeds CONTEXT_CAP_TOKENS, compact immediately,
 *    regardless of what the model's own window would otherwise allow.
 *
 * 2. METERING. pixe's submit endpoint accepts an optional, self-reported
 *    `meter: { tokensIn, tokensOut, costMicro }` object, and the server keeps
 *    it *per puzzle*: only the value attached to the submit that finally
 *    accepts a rung is stored (server/runs.ts, postSubmit — phase handoffs
 *    and probes never persist `meter` at all). So what the agent must send on
 *    every submit is "tokens spent on the puzzle I currently hold", not
 *    "tokens spent all run" — reporting the whole-session running total on
 *    every puzzle would make every puzzle after the first look like it cost
 *    the entire run so far.
 *
 *    This extension tracks whole-session cumulative usage (every assistant
 *    message, nested tool-call usage, and compaction-summary usage, matching
 *    what pi's own footer counts) and writes it to `meter.json` in the
 *    workdir on every message. It also tracks a "puzzle baseline" — a
 *    snapshot of the cumulative totals taken whenever the agent says a new
 *    puzzle has started — and publishes cumulative-minus-baseline as the
 *    puzzle* fields in the same file, which is what should actually go on
 *    the wire. A `pixe_meter` tool does the arithmetic and the reset so nei-
 *    ther has to be done by the model by hand from a stream of numbers.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// The cap. This is the one number this file is about; nothing else here is
// policy. Raise or lower it to change what "too much live context" means.
// ---------------------------------------------------------------------------
const CONTEXT_CAP_TOKENS = 250_000;

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

  // Edge-triggered like pi's own trigger-compact example: only fire on the
  // transition from at-or-under the cap to over it, and only one compaction
  // at a time. ctx.getContextUsage().tokens returns null immediately after a
  // compaction (until the next assistant response), which already prevents
  // a tight re-trigger loop; `compacting` is a second, explicit guard for the
  // window before that first null shows up.
  let previousTokens: number | null = null;
  let compacting = false;

  const maybeCompact = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens ?? null;
    if (tokens === null) {
      previousTokens = null;
      return;
    }
    const crossedUp = previousTokens !== null && previousTokens <= CONTEXT_CAP_TOKENS && tokens > CONTEXT_CAP_TOKENS;
    previousTokens = tokens;
    if (!crossedUp || compacting) return;

    compacting = true;
    if (ctx.hasUI) ctx.ui.notify(`pixe-meter: context ${tokens.toLocaleString()} > ${CONTEXT_CAP_TOKENS.toLocaleString()} cap, compacting`, "info");
    ctx.compact({
      customInstructions:
        "This is a pixe benchmark run. Preserve every deduced law, ruled-out hypothesis, and the current puzzle's " +
        "state (rung, phase, key, filled cells, what has been tried) verbatim. Losing a deduction costs real probes.",
      onComplete: () => {
        compacting = false;
        previousTokens = null;
      },
      onError: () => {
        compacting = false;
      },
    });
  };

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      addUsage(cumulative, event.message.usage);
    } else if (event.message.role === "toolResult" && event.message.usage) {
      // Nested LLM work done inside a tool call, counted the same way pi's
      // own session totals count it.
      addUsage(cumulative, event.message.usage);
    }
    writeMeter(cumulative, puzzleBaseline);
    maybeCompact(ctx);
  });

  // Compaction summaries cost tokens too, and pi counts them in session
  // totals — so a meter that wants to match pi's own footer must as well.
  pi.on("session_compact", (event) => {
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
