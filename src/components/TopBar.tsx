import { LogOut, Trophy } from "lucide-react";
import { HUES } from "@shared/palette";
import type { AuthState } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Props {
  auth: AuthState;
  onHome(): void;
  onLeaderboard(): void;
  onSignOut(): void;
  onSignIn(): void;
}

export function TopBar({ auth, onHome, onLeaderboard, onSignOut, onSignIn }: Props) {
  return (
    <header className="mx-auto mb-5 flex w-full max-w-350 flex-wrap items-center gap-3 px-4 py-4">
      <button type="button" onClick={onHome} className="group flex items-center gap-2" aria-label="pixe home">
        <span className="flex gap-0.5">
          {HUES.slice(0, 4).map((h, i) => (
            <span
              key={h.id}
              className="size-4 rounded-sm border-2 border-ink transition-transform group-hover:-translate-y-0.5"
              style={{ backgroundColor: h.hex, transitionDelay: `${i * 35}ms` }}
            />
          ))}
        </span>
        <span className="font-display text-2xl leading-none">pixe</span>
      </button>

      <div className="ml-auto flex items-center gap-2">
        {auth.user && auth.stats && (
          <>
            <Badge variant="default" title="Total points">
              {auth.stats.score} pts
            </Badge>
            <Badge variant="plain" className="hidden sm:inline-flex" title="Puzzles solved">
              {auth.stats.solved} solved
            </Badge>
          </>
        )}
        <Button size="sm" variant="secondary" onClick={onLeaderboard}>
          <Trophy className="size-4" strokeWidth={2.5} />
          <span className="hidden sm:inline">Board</span>
        </Button>
        {auth.user ? (
          <Button size="sm" variant="ghost" onClick={onSignOut} title={`Signed in as ${auth.user.name}`}>
            <span className="max-w-24 truncate font-display">{auth.user.name}</span>
            <LogOut className="size-4" strokeWidth={2.5} />
          </Button>
        ) : (
          <Button size="sm" onClick={onSignIn}>
            Sign in
          </Button>
        )}
      </div>
    </header>
  );
}
