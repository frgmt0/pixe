import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
  Two real buttons and three quiet ones.

  datacurve.ai pairs a dark filled primary with a plain hairline-outlined
  secondary, both small, both barely rounded. That pair is the whole set here:
  `solid` is the one action a screen wants, `outline` is everything else, and
  `ghost` is for controls that live inside other furniture (nav, toolbars).

  There is no press-down affordance any more. The old `chunk` shadow moved the
  element 3px on click, which is charming exactly once. State is shown by the
  border and the fill instead.
*/
const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px]",
    "font-normal select-none transition-colors duration-100",
    "disabled:opacity-40 disabled:pointer-events-none",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ),
  {
    variants: {
      variant: {
        solid: "bg-solid text-on-solid hover:opacity-85",
        outline: "rule-all bg-page text-ink hover:bg-sunk",
        ghost: "bg-transparent text-muted hover:text-ink hover:bg-sunk",
        /* Destructive and confirming actions keep the status hue as an outline
           rather than a fill — a page whose only saturated element is a red
           button reads as an error state even when nothing is wrong. */
        danger: "border-[0.8px] border-solid border-bad/50 bg-transparent text-bad hover:bg-bad/8",
        good: "border-[0.8px] border-solid border-good/50 bg-transparent text-good hover:bg-good/8",
      },
      size: {
        default: "h-8 px-3 text-[13px]",
        sm: "h-7 px-2.5 text-[12px]",
        lg: "h-10 px-4 text-[13px]",
        icon: "size-8",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: { variant: "solid", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
