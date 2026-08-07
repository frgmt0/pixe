import * as React from "react";
import { cn } from "@/lib/utils";

/*
  A field is a hairline box on the raised surface. No inner shadow, no heavy
  border — the focus state is a single ink outline, which is the same signal
  every other focusable thing on the page gives.
*/
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-[5px] rule-all bg-raise px-2.5 text-[13px] text-ink",
        "transition-colors placeholder:text-muted/70",
        "focus:outline-none focus-visible:outline-1 focus-visible:outline-ink focus-visible:outline-offset-0",
        "focus-visible:border-ink disabled:opacity-45",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
