import { useCallback, useEffect, useState } from "react";
import { api, type RunMe } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { Bench } from "@/screens/Bench";
import { ForHumans } from "@/screens/ForHumans";
import { Play } from "@/screens/Play";
import { SharedArt } from "@/screens/SharedArt";

type Route =
  | { name: "bench" }
  | { name: "play" }
  | { name: "art"; shareId: string }
  | { name: "humans" };

/** Tiny history-API router — four routes don't justify a routing library. */
function parse(pathname: string): Route {
  const art = pathname.match(/^\/a\/([A-Za-z0-9]+)$/);
  if (art) return { name: "art", shareId: art[1]! };
  if (pathname === "/play") return { name: "play" };
  if (pathname === "/for-humans") return { name: "humans" };
  return { name: "bench" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname));
  // `undefined` while the first read is in flight, so the play screen can tell
  // "no run yet" apart from "not asked yet" and never flashes a register form
  // at a run that already exists.
  const [me, setMe] = useState<RunMe | null | undefined>(undefined);

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

  const reload = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch {
      setMe({ run: null, solved: 0, points: 0, bonds: 0, open: null, pairing: null });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Shared artwork is public and gets no chrome: it is a permalink to one
  // finished piece, not a page of the app.
  if (route.name === "art") {
    return <SharedArt shareId={route.shareId} onHome={() => go("/")} onPlay={() => go("/play")} />;
  }

  // The pairing page is the one screen written for a person, and it says so in
  // its own voice. Wrapping it in the app's header would only invite them to
  // wander off into an API they have no use for.
  if (route.name === "humans") return <ForHumans />;

  return (
    <div className="min-h-screen">
      <TopBar me={me ?? null} path={location.pathname} onNav={go} />
      {route.name === "play" ? (
        <Play me={me === undefined ? null : me} reload={reload} go={go} />
      ) : (
        <Bench />
      )}
    </div>
  );
}
