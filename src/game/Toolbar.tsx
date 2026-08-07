import {
  Brush,
  Eraser,
  Grid3x3,
  PaintBucket,
  Pipette,
  Redo2,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import type { Mirror, Tool } from "./board";
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
  { id: "none", label: "off" },
  { id: "x", label: "◧" },
  { id: "y", label: "⬒" },
  { id: "quad", label: "✚" },
];

/**
 * Every control here is the same object: a hairline cell that fills with ink
 * when it is the active one. Segmented rather than spaced, which is how both
 * DeepSWE's chart switches and datacurve's nav read — one border around the
 * group, one internal hairline between cells, and the selected cell inverted.
 */
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
        <div className="flex items-center gap-2">
          <Segmented>
            {TOOLS.map((t) => (
              <Cell
                key={t.id}
                on={tool === t.id}
                onClick={() => setTool(t.id)}
                title={`${t.label} (${t.hotkey})`}
                aria-label={t.label}
                aria-pressed={tool === t.id}
              >
                <t.icon className="size-3.5" strokeWidth={1.75} />
              </Cell>
            ))}
          </Segmented>

          <Segmented>
            <Cell on={false} onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo">
              <Undo2 className="size-3.5" strokeWidth={1.75} />
            </Cell>
            <Cell on={false} onClick={onRedo} disabled={!canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
              <Redo2 className="size-3.5" strokeWidth={1.75} />
            </Cell>
            {/* `Wipe the canvas` is a documented seam — the reference solver
                finds this button by that exact aria-label. */}
            <Cell on={false} onClick={onClear} title="Wipe the canvas" aria-label="Wipe the canvas">
              <Trash2 className="size-3.5" strokeWidth={1.75} />
            </Cell>
          </Segmented>
        </div>
      </Section>

      <Section label="Brush size">
        <Segmented full>
          {BRUSHES.map((n) => (
            <Cell key={n} on={brush === n} onClick={() => setBrush(n)} title={`${n}×${n}`} grow>
              <span className="t-num text-[11px]">{n}</span>
            </Cell>
          ))}
        </Segmented>
      </Section>

      <div className="grid grid-cols-2 gap-3">
        <Section label="Mirror">
          <Segmented full>
            {MIRRORS.map((m) => (
              <Cell
                key={m.id}
                on={mirror === m.id}
                onClick={() => setMirror(m.id)}
                title={`Mirror: ${m.label}`}
                aria-pressed={mirror === m.id}
                grow
              >
                <span className="text-[11px]">{m.label}</span>
              </Cell>
            ))}
          </Segmented>
        </Section>

        <Section label="Guides">
          <Segmented full>
            <Cell
              on={showGrid}
              onClick={() => setShowGrid(!showGrid)}
              aria-pressed={showGrid}
              title="8×8 guide grid"
              grow
            >
              <Grid3x3 className="size-3.5" strokeWidth={1.75} />
              <span className="text-[11px]">8×8</span>
            </Cell>
          </Segmented>
        </Section>
      </div>
    </div>
  );
}

function Segmented({ children, full }: { children: React.ReactNode; full?: boolean }) {
  return (
    <div
      className={cn(
        "flex overflow-hidden rounded-[4px] rule-all",
        // One internal hairline between cells, never a doubled border.
        "[&>button:not(:first-child)]:rule-l",
        full && "w-full",
      )}
    >
      {children}
    </div>
  );
}

function Cell({
  on,
  grow,
  children,
  className,
  ...props
}: React.ComponentProps<"button"> & { on: boolean; grow?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-7 min-w-7 items-center justify-center gap-1 px-1.5 transition-colors",
        on ? "bg-solid text-on-solid" : "text-muted hover:bg-sunk hover:text-ink",
        "disabled:opacity-35 disabled:hover:bg-transparent",
        grow && "flex-1",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="t-micro mb-1.5 text-muted">{label}</h2>
      {children}
    </div>
  );
}
