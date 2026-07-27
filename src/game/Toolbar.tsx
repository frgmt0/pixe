import {
  Brush,
  Eraser,
  FlipHorizontal2,
  Grid3x3,
  PaintBucket,
  Pipette,
  Redo2,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import type { Mirror, Tool } from "./board";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  tool: Tool;
  setTool(t: Tool): void;
  brush: number;
  setBrush(n: number): void;
  mirror: Mirror;
  setMirror(m: Mirror): void;
  showGrid: boolean;
  setShowGrid(v: boolean): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onClear(): void;
}

const TOOLS: { id: Tool; icon: typeof Brush; label: string; hotkey: string }[] = [
  { id: "brush", icon: Brush, label: "Brush", hotkey: "B" },
  { id: "bucket", icon: PaintBucket, label: "Flood fill", hotkey: "G" },
  { id: "rect", icon: Square, label: "Rectangle", hotkey: "R" },
  { id: "eraser", icon: Eraser, label: "Eraser", hotkey: "E" },
  { id: "picker", icon: Pipette, label: "Pick colour", hotkey: "I" },
];

const BRUSHES = [1, 2, 4, 8, 16];

const MIRRORS: { id: Mirror; label: string }[] = [
  { id: "none", label: "Off" },
  { id: "x", label: "◧" },
  { id: "y", label: "⬒" },
  { id: "quad", label: "✚" },
];

export function Toolbar({
  tool,
  setTool,
  brush,
  setBrush,
  mirror,
  setMirror,
  showGrid,
  setShowGrid,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
}: Props) {
  return (
    <div className="flex flex-col gap-3">
      <Section label="Tools">
        <div className="flex flex-wrap gap-1.5">
          {TOOLS.map((t) => (
            <Button
              key={t.id}
              size="icon-sm"
              variant={tool === t.id ? "ink" : "secondary"}
              onClick={() => setTool(t.id)}
              title={`${t.label} (${t.hotkey})`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
            >
              <t.icon className="size-4" strokeWidth={2.5} />
            </Button>
          ))}
          <span className="mx-1 w-px self-stretch bg-ink/25" />
          <Button size="icon-sm" variant="secondary" onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo">
            <Undo2 className="size-4" strokeWidth={2.5} />
          </Button>
          <Button size="icon-sm" variant="secondary" onClick={onRedo} disabled={!canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
            <Redo2 className="size-4" strokeWidth={2.5} />
          </Button>
          <Button size="icon-sm" variant="secondary" onClick={onClear} title="Wipe the canvas" aria-label="Wipe the canvas">
            <Trash2 className="size-4" strokeWidth={2.5} />
          </Button>
        </div>
      </Section>

      <Section label="Brush size">
        <div className="flex gap-1.5">
          {BRUSHES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setBrush(n)}
              aria-pressed={brush === n}
              title={`${n}×${n}`}
              className={cn(
                "h-8 flex-1 rounded-lg ink-border font-display text-xs shadow-chunk-sm transition-transform hover:-translate-y-0.5",
                brush === n ? "bg-ink text-paper" : "bg-paper text-ink",
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-2 gap-3">
        <Section label="Mirror" hint={<FlipHorizontal2 className="size-3.5" strokeWidth={2.5} />}>
          <div className="flex gap-1.5">
            {MIRRORS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMirror(m.id)}
                aria-pressed={mirror === m.id}
                title={`Mirror: ${m.label}`}
                className={cn(
                  "h-8 flex-1 rounded-lg ink-border font-display text-xs shadow-chunk-sm transition-transform hover:-translate-y-0.5",
                  mirror === m.id ? "bg-ink text-paper" : "bg-paper text-ink",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </Section>

        <Section label="Guides" hint={<Grid3x3 className="size-3.5" strokeWidth={2.5} />}>
          <button
            type="button"
            onClick={() => setShowGrid(!showGrid)}
            aria-pressed={showGrid}
            className={cn(
              "h-8 w-full rounded-lg ink-border font-display text-xs shadow-chunk-sm transition-transform hover:-translate-y-0.5",
              showGrid ? "bg-ink text-paper" : "bg-paper text-ink",
            )}
          >
            {showGrid ? "8×8 grid on" : "8×8 grid off"}
          </button>
        </Section>
      </div>
    </div>
  );
}

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="mb-1.5 flex items-center gap-1 font-display text-sm uppercase tracking-wide text-ink-soft">
        {label}
        {hint}
      </h2>
      {children}
    </div>
  );
}
