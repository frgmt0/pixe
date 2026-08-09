import { useState } from "react";
import { HUES } from "@shared/palette";
import type { RunMe } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Props {
  me: RunMe | null;
  path: string;
  onNav(path: string): void;
}

const NAV = [
  { path: "/", label: "Benchmark" },
  { path: "/research", label: "Research" },
  { path: "/run", label: "Run it" },
];

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

const THEME_KEY = "pixe:theme";
type Theme = "light" | "dark" | "system";

/**
 * Restored at module load rather than in an effect, so the stamp is on
 * `<html>` before React paints anything and a dark reader never gets a frame
 * of white. This module is imported by `App` on every route, including the two
 * that render no header, so the restore is global even though the control that
 * sets it is not.
 */
function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function stamp(t: Theme) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

if (typeof document !== "undefined") stamp(readTheme());

/**
 * Both modes are first-class, so both have to be reachable — `prefers-color-scheme`
 * alone leaves half the design unseeable by anyone who cannot change their OS.
 * Three states rather than two: "system" is the default and returning to it has
 * to be possible, which a plain toggle cannot express.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  const next = () => {
    const order: Theme[] = ["system", "light", "dark"];
    const t = order[(order.indexOf(theme) + 1) % order.length]!;
    setTheme(t);
    stamp(t);
    try {
      if (t === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, t);
    } catch {
      /* Private mode. The stamp still applies for this session. */
    }
  };

  return (
    <button
      type="button"
      onClick={next}
      title="Switch between system, light and dark"
      aria-label={`Colour theme: ${theme}. Click to change.`}
      className="rounded-[4px] px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-sunk hover:text-ink"
    >
      {theme}
    </button>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Navigation, and what the current run is. There is nothing to sign into and
 * nobody to be signed in as — a player here is a run, held in a cookie, and the
 * only thing worth showing about it is whether it is allowed to draw yet.
 *
 * A single hairline under it and no fill. The active route is ink and the rest
 * are muted, which is the only state change frgmt.xyz's own navigation makes.
 */
export function TopBar({ me, path, onNav }: Props) {
  const run = me?.run ?? null;

  return (
    <header className="rule-b">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
        <button
          type="button"
          onClick={() => onNav("/")}
          className="group flex items-center gap-1.5"
          aria-label="pixe home"
        >
          {/* The one place the eight hues appear outside the canvas. Four 6px
              squares, no borders — a mark, not a logo. */}
          <span className="flex gap-px" aria-hidden>
            {HUES.slice(0, 4).map((h) => (
              <span key={h.id} className="size-1.5" style={{ backgroundColor: h.hex }} />
            ))}
          </span>
          <span className="text-[14px] tracking-[-0.02em]">pixe</span>
        </button>

        <nav className="flex items-center gap-4">
          {NAV.map((item) => (
            <button
              key={item.path}
              type="button"
              onClick={() => onNav(item.path)}
              aria-current={path === item.path ? "page" : undefined}
              className={`text-[13px] transition-colors ${
                path === item.path ? "text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {run ? (
            <>
              <Badge
                variant="bare"
                className="max-w-56 truncate"
                title={
                  run.config
                    ? `Declared by the run · ${run.config}`
                    : "Declared by the run, unverified"
                }
              >
                {run.model}
              </Badge>
              {run.status === "open" ? (
                <>
                  <Badge title="Points banked by this run">{me!.points} pts</Badge>
                  <Badge variant="bare" className="hidden sm:inline-flex" title="Puzzles solved">
                    {me!.solved} solved
                  </Badge>
                </>
              ) : (
                <Badge variant="bad">{run.status}</Badge>
              )}
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onNav("/run")}>
              Run it
            </Button>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
