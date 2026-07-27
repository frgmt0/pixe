import { useMemo } from "react";
import { HUES } from "@shared/palette";

/**
 * Pure-CSS confetti burst. No canvas, no library, no rAF loop — it plays once
 * and then sits there doing nothing, which is exactly what a celebration
 * should cost.
 */
export function Confetti({ count = 70 }: { count?: number }) {
  const bits = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.5,
        duration: 2.2 + Math.random() * 1.6,
        size: 7 + Math.random() * 9,
        color: HUES[i % HUES.length]!.hex,
        spin: `${(Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 720)}deg`,
        round: Math.random() > 0.6,
      })),
    [count],
  );

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-100 overflow-hidden">
      {bits.map((b) => (
        <span
          key={b.id}
          className="absolute -top-8 block border-2 border-ink"
          style={{
            left: `${b.left}%`,
            width: b.size,
            height: b.size * (b.round ? 1 : 1.6),
            backgroundColor: b.color,
            borderRadius: b.round ? "50%" : 2,
            ["--spin" as string]: b.spin,
            animation: `confetti-fall ${b.duration}s linear ${b.delay}s forwards`,
          }}
        />
      ))}
    </div>
  );
}
