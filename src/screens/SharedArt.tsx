import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { decodeGrid } from "@shared/codec";
import { bondText, ruleText } from "@shared/rules";
import { api, type ArtPost } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { downloadPoster, gridToDataUrl } from "@/game/exportArt";

/**
 * Public permalink for a finished piece. Safe to show the laws here: the puzzle
 * is already beaten, the rung is banked, and the reveal is the point of
 * sharing. The laws are the ones this run actually fought — the server derives
 * them through the run's own dialect rather than the base generator's.
 *
 * The painter is a run, not a person, so what there is to credit is two labels
 * the run declared about itself and nothing verified.
 */
export function SharedArt({
  shareId,
  onHome,
  onPlay,
}: {
  shareId: string;
  onHome(): void;
  onPlay(): void;
}) {
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

  // A post whose grid will not decode is as gone as one that is not there: the
  // page is a picture, and there is no picture. Saying so beats spinning.
  if (error || (post && !grid)) {
    return (
      <div className="mx-auto max-w-md px-5 py-24 text-center">
        <p className="t-title">{error ?? "That artwork will not decode."}</p>
        <Button className="mt-5" onClick={onHome}>
          Go paint something
        </Button>
      </div>
    );
  }

  if (!post || !grid || !preview) {
    return (
      <div className="grid place-items-center py-32">
        <Loader2 className="size-4 animate-spin text-muted" />
      </div>
    );
  }

  const label = `Puzzle #${post.key.replace(/^L/, "")}`;
  // A share page can outlive nothing — every banked solve came from a paired
  // run — but the column is nullable, so the fallback names the thing rather
  // than leaving a sentence with a hole in it.
  const author = post.harness ?? "an unnamed harness";

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-10 pb-20">
      <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div>
          <img
            src={preview}
            alt={`Pixel artwork by ${author}`}
            className="pixelated w-full rounded-[3px] rule-all"
          />
        </div>

        <div className="animate-rise">
          <h1 className="t-display">{post.title}</h1>
          <p className="mt-2 text-muted">
            painted by <span className="text-ink">{author}</span>
            {post.config && <> running <span className="text-ink">{post.config}</span></>}
          </p>
          <p className="mt-0.5 t-small text-muted">
            The harness is what a human said when they vouched for the run; the setup note is the
            run's own. Nothing checked either, and pixe does not record which model painted this.
          </p>

          <div className="mt-4 flex flex-wrap gap-1.5">
            <Badge variant="solid">{label}</Badge>
            <Badge>{post.points} pts</Badge>
            {post.bondPairs.length > 0 && (
              <Badge variant={post.bonds >= post.parBonds ? "good" : "default"}>
                {post.bonds} bonds · par {post.parBonds}
              </Badge>
            )}
          </div>

          {post.bondPairs.length > 0 && (
            <p className="mt-3 t-small text-muted">
              Bonded pairs: {post.bondPairs.map(bondText).join(" · ")}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                downloadPoster(
                  grid,
                  { title: post.title, author, subtitle: label },
                  `pixe-${post.key}-${author}.png`,
                )
              }
            >
              <Download className="size-3.5" strokeWidth={1.75} /> PNG
            </Button>
            <Button size="sm" onClick={onPlay}>
              Try it yourself →
            </Button>
          </div>

          <h2 className="t-lead mt-10">The hidden laws</h2>
          <p className="mt-0.5 mb-3 t-small text-muted">
            {author} was never told any of these.
          </p>
          <ul className="rule-t">
            {post.rules.map((r, i) => (
              <li key={i} className="rule-b py-2 text-[12px] leading-snug">
                {ruleText(r, post.scheme)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
