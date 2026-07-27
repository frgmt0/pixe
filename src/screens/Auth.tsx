import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { HUES } from "@shared/palette";
import { api, ApiError, type AuthState } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Props {
  onDone(state: AuthState): void;
  onSkip(): void;
}

export function Auth({ onDone, onSkip }: Props) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const state = mode === "signup" ? await api.signup(name, password) : await api.login(name, password);
      onDone(state);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[80vh] w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <div className="mb-3 flex justify-center gap-1">
          {HUES.map((h, i) => (
            <span
              key={h.id}
              className="size-6 rounded-md ink-border shadow-chunk-sm"
              style={{
                backgroundColor: h.hex,
                transform: `rotate(${(i % 2 ? 1 : -1) * (3 + i)}deg)`,
              }}
            />
          ))}
        </div>
        <h1 className="font-display text-4xl">
          {mode === "signup" ? "Make a name for yourself" : "Welcome back"}
        </h1>
        <p className="mt-1 text-sm font-bold text-ink-soft">
          {mode === "signup"
            ? "You'll need somewhere to keep your points."
            : "The grid missed you. Probably."}
        </p>
      </div>

      <form onSubmit={submit} className="rounded-2xl ink-border bg-paper p-5 shadow-chunk-lg">
        <label className="mb-1.5 block font-display text-sm uppercase tracking-wide text-ink-soft" htmlFor="name">
          Name
        </label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="username"
          placeholder="grid_goblin"
          maxLength={20}
          required
        />

        <label className="mb-1.5 mt-4 block font-display text-sm uppercase tracking-wide text-ink-soft" htmlFor="password">
          Password
        </label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          placeholder="at least 6 characters"
          minLength={6}
          required
        />

        {error && (
          <p className="mt-3 rounded-lg border-[2.5px] border-ink bg-bad px-3 py-2 text-sm font-bold text-white">
            {error}
          </p>
        )}

        <Button type="submit" size="lg" className="mt-5 w-full" disabled={busy}>
          {busy ? <Loader2 className="size-5 animate-spin" /> : mode === "signup" ? "Let's go" : "Sign in"}
        </Button>

        <p className="mt-4 text-center text-sm font-bold text-ink-soft">
          {mode === "signup" ? "Already have a name?" : "New here?"}{" "}
          <button
            type="button"
            className="underline decoration-pop-2 decoration-3 underline-offset-2 hover:text-ink"
            onClick={() => {
              setMode(mode === "signup" ? "login" : "signup");
              setError(null);
            }}
          >
            {mode === "signup" ? "Sign in" : "Make one"}
          </button>
        </p>
      </form>

      <button
        type="button"
        onClick={onSkip}
        className={cn(
          "mx-auto mt-5 text-sm font-bold text-ink-faint underline underline-offset-2 hover:text-ink-soft",
        )}
      >
        just let me paint (no points)
      </button>
    </div>
  );
}
