import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border-[2.5px] border-ink px-2.5 py-0.5 font-display text-xs leading-5",
  {
    variants: {
      variant: {
        default: "bg-pop text-ink",
        ink: "bg-ink text-paper",
        good: "bg-good text-white",
        bad: "bg-bad text-white",
        plain: "bg-white text-ink",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
