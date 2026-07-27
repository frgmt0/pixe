import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { decodeGrid } from "@shared/codec";
import { bondText, ruleText } from "@shared/rules";
import { api, type ArtPost } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { downloadPoster, gridToDataUrl } from "@/game/exportArt";

/**
 * Public permalink for a finished piece. Safe to show the laws here: the
 * puzzle is already beaten, and the reveal is the point of sharing.
 */
export function SharedArt({ shareId, onHome }: { shareId: string; onHome(): void }) {
  const [post, setPost] = useState<ArtPost | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .art(shareId)
      .then(setPost)
      .catch(() => setError("That artwork has wandered off."));
  }, [shareId]);

  const grid = useMemo(() => (post ? decodeGrid(post.art) : null), [post]);
  const preview = useMemo(() => (grid ? gridToDataUrl(grid, 8) : null), [grid]);

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <p className="font-display text-2xl">{error}</p>
        <Button className="mt-5" onClick={onHome}>
          Go paint something
        </Button>
      </div>
    );
  }

  if (!post || !grid || !preview) {
    return (
      <div className="grid place-items-center py-32">
        <Loader2 className="size-8 animate-spin text-ink-faint" />
      </div>
    );
  }

  const label = post.key.startsWith("D") ? `Daily ${post.key.slice(1)}` : `Puzzle #${post.key.slice(1)}`;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16">
      <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <img
            src={preview}
            alt={`Pixel artwork by ${post.name}`}
            className="pixelated w-full rounded-xl ink-border shadow-chunk-lg"
          />
        </div>

        <div className="animate-rise">
          <h1 className="font-display text-3xl leading-tight">{post.title}</h1>
          <p className="mt-1 font-bold text-ink-soft">
            painted by <span className="text-ink">{post.name}</span>
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="ink">{label}</Badge>
            <Badge variant="plain">{post.points} pts</Badge>
            {post.bondPairs.length > 0 && (
              <Badge variant={post.bonds >= post.parBonds ? "good" : "plain"}>
                {post.bonds} bonds · par {post.parBonds}
              </Badge>
            )}
          </div>

          {post.bondPairs.length > 0 && (
            <p className="mt-3 text-xs font-bold text-ink-soft">
              Bonded pairs: {post.bondPairs.map(bondText).join(" · ")}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                downloadPoster(
                  grid,
                  { title: post.title, author: post.name, subtitle: label },
                  `pixe-${post.key}-${post.name}.png`,
                )
              }
            >
              <Download className="size-4" strokeWidth={3} /> PNG
            </Button>
            <Button size="sm" onClick={onHome}>
              Try it yourself →
            </Button>
          </div>

          <h2 className="mt-8 font-display text-lg">The hidden laws</h2>
          <p className="mb-3 text-xs font-bold text-ink-faint">
            {post.name} was never told any of these.
          </p>
          <ul className="flex flex-col gap-2">
            {post.rules.map((r, i) => (
              <li
                key={i}
                className="rounded-xl border-[2.5px] border-ink bg-white px-3 py-2 text-sm font-semibold leading-snug"
              >
                {ruleText(r, post.scheme)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
