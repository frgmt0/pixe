import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-12 w-full rounded-xl ink-border bg-white px-4 text-base font-semibold text-ink shadow-chunk-sm",
        "placeholder:text-ink-faint placeholder:font-medium",
        "focus:outline-none focus-visible:outline-3 focus-visible:outline-pop-2 focus-visible:outline-offset-2",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
