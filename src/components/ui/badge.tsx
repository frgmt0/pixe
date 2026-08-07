import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
  A badge here is a meta chip, not an award. Most of what it carries is a
  figure — points, a puzzle key, a solve count — so it is set in mono at the
  smallest size in the scale, with a hairline instead of a fill.

  `solid` exists for the one value on a screen that is genuinely the subject.
  Using it twice in one row is a sign something else should have been demoted.
*/
const badgeVariants = cva(
  cn(
    "inline-flex items-center gap-1 rounded-[4px] px-1.5 py-px",
    "font-mono text-[11px] leading-[16px] tabular-nums tracking-[-0.02em] whitespace-nowrap",
  ),
  {
    variants: {
      variant: {
        default: "rule-all text-muted",
        solid: "bg-solid text-on-solid",
        good: "border-[0.8px] border-solid border-good/45 text-good",
        bad: "border-[0.8px] border-solid border-bad/45 text-bad",
        /* No box at all — for a label that only needs to be quieter than its
           neighbours, which on this palette is just a colour change. */
        bare: "text-muted",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
