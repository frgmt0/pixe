import * as React from "react";
import { cn } from "@/lib/utils";

/*
  A card is a hairline and nothing else — no shadow, no fill, no radius worth
  noticing. On frgmt.xyz and on the DeepSWE leaderboard, grouping is done with
  space first and a 0.8px rule only where space alone would be ambiguous, so
  reach for a bare section before reaching for this.
*/
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-[6px] rule-all bg-page", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-0.5 p-4", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn("t-lead text-ink", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("t-small text-muted", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-4 pt-0", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
