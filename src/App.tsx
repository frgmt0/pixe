import { useCallback, useEffect, useState } from "react";
import { api, type RunMe } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { Bench } from "@/screens/Bench";
import { Guide } from "@/screens/Guide";
import { SharedArt } from "@/screens/SharedArt";

type Route = { name: "bench" } | { name: "guide" } | { name: "art"; shareId: string };

/** Tiny history-API router — three routes don't justify a routing library. */
function parse(pathname: string): Route {
  const art = pathname.match(/^\/a\/([A-Za-z0-9]+)$/);
  if (art) return { name: "art", shareId: art[1]! };
  if (pathname === "/run") return { name: "guide" };
  return { name: "bench" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname));
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
      setMe({ run: null, solved: 0, points: 0, bonds: 0, open: null });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Shared artwork is public and gets no chrome: it is a permalink to one
  // finished piece, not a page of the app.
  if (route.name === "art") {
    return <SharedArt shareId={route.shareId} onHome={() => go("/")} onGuide={() => go("/run")} />;
  }

  return (
    <div className="min-h-screen">
      <TopBar me={me ?? null} path={location.pathname} onNav={go} />
      {route.name === "guide" ? <Guide /> : <Bench />}
    </div>
  );
}
