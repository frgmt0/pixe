import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-display font-semibold ink-border chunk select-none disabled:opacity-45 disabled:shadow-none disabled:translate-0 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-pop text-ink",
        secondary: "bg-paper text-ink",
        ghost: "bg-transparent border-transparent shadow-none hover:bg-ink/10 hover:shadow-none hover:translate-0 active:translate-0 active:shadow-none",
        danger: "bg-bad text-white",
        good: "bg-good text-white",
        ink: "bg-ink text-paper",
      },
      size: {
        default: "h-11 px-5 text-base",
        sm: "h-9 px-3 text-sm",
        lg: "h-14 px-8 text-xl",
        icon: "size-11",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
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
