import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { isValidKey } from "@shared/generate";
import { api, type AuthState, type SolveResult } from "@/lib/api";
import { Leaderboard } from "@/components/Leaderboard";
import { TopBar } from "@/components/TopBar";
import { Auth } from "@/screens/Auth";
import { Ladder } from "@/screens/Ladder";
import { Play } from "@/screens/Play";
import { SharedArt } from "@/screens/SharedArt";

type Route =
  | { name: "ladder" }
  | { name: "play"; key: string }
  | { name: "art"; shareId: string }
  | { name: "auth" };

/** Tiny history-API router — three routes don't justify a routing library. */
function parse(pathname: string): Route {
  const play = pathname.match(/^\/play\/([A-Za-z0-9-]+)$/);
  if (play && isValidKey(play[1]!)) return { name: "play", key: play[1]! };
  const art = pathname.match(/^\/a\/([A-Za-z0-9]+)$/);
  if (art) return { name: "art", shareId: art[1]! };
  if (pathname === "/signin") return { name: "auth" };
  return { name: "ladder" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname));
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);

  const go = useCallback((path: string, replace = false) => {
    history[replace ? "replaceState" : "pushState"]({}, "", path);
    setRoute(parse(path));
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parse(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    api
      .me()
      .then(setAuth)
      .catch(() => setAuth({ user: null }));
  }, []);

  const onSolved = useCallback((r: SolveResult) => {
    setAuth({ user: r.user, stats: r.stats, solves: r.solves });
  }, []);

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    setAuth({ user: null });
    go("/");
  };

  if (!auth) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loader2 className="size-8 animate-spin text-ink-faint" />
      </div>
    );
  }

  // Shared artwork is public — no chrome, no sign-in wall.
  if (route.name === "art") {
    return (
      <div className="min-h-screen">
        <TopBar
          auth={auth}
          onHome={() => go("/")}
          onLeaderboard={() => setBoardOpen(true)}
          onSignOut={signOut}
          onSignIn={() => go("/signin")}
        />
        <SharedArt shareId={route.shareId} onHome={() => go("/")} />
        <Leaderboard open={boardOpen} onClose={() => setBoardOpen(false)} me={auth.user?.name} />
      </div>
    );
  }

  if (route.name === "auth" || (!auth.user && route.name === "ladder" && !seenIntro())) {
    return (
      <div className="min-h-screen">
        <Auth
          onDone={(s) => {
            setAuth(s);
            go("/");
          }}
          onSkip={() => {
            markIntroSeen();
            go("/");
          }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <TopBar
        auth={auth}
        onHome={() => go("/")}
        onLeaderboard={() => setBoardOpen(true)}
        onSignOut={signOut}
        onSignIn={() => go("/signin")}
      />

      {route.name === "ladder" ? (
        <>
          <Hero signedIn={!!auth.user} />
          <Ladder solves={auth.solves ?? []} onOpen={(key) => go(`/play/${key}`)} />
        </>
      ) : (
        <Play
          key={route.key}
          puzzleKey={route.key}
          signedIn={!!auth.user}
          alreadySolved={(auth.solves ?? []).some((s) => s.key === route.key)}
          onBack={() => go("/")}
          onSolved={onSolved}
          onNeedAuth={() => go("/signin")}
        />
      )}

      <Leaderboard open={boardOpen} onClose={() => setBoardOpen(false)} me={auth.user?.name} />
    </div>
  );
}

function Hero({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="mx-auto mb-8 w-full max-w-5xl px-4">
      <div className="rounded-2xl ink-border bg-paper-2 p-6 shadow-chunk-lg">
        <h1 className="font-display text-3xl leading-tight sm:text-4xl">
          Fill the grid. <span className="inline-block animate-wobble">Nobody tells you how.</span>
        </h1>
        <p className="mt-2 max-w-2xl font-bold text-ink-soft">
          Every puzzle hides its own laws about which colours may go where, and which colours can
          stand next to each other. You will not be told any of them. Paint a square, and the grid
          will let you know if it hated that.
        </p>
        <p className="mt-2 max-w-2xl text-sm font-bold text-ink-faint">
          Flashing cells mean a law was broken there. A twitching swatch means that colour is the
          problem, somewhere. Work out the rest yourself.
          {!signedIn && " Sign in to bank points on the leaderboard."}
        </p>
      </div>
    </section>
  );
}

/* The sign-in wall is a soft one: skip it once and it stays skipped. */
const INTRO_KEY = "pixe:skipped-auth";
const seenIntro = () => localStorage.getItem(INTRO_KEY) === "1";
const markIntroSeen = () => localStorage.setItem(INTRO_KEY, "1");
