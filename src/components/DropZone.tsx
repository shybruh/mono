import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Drop target shown while files are dragged over the window. Stays mounted so it can fade. */
export function DropZone({ on, icon: Icon, filled }: { on: boolean; icon: LucideIcon; filled?: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-brand/60 bg-brand-wash/85 backdrop-blur-[3px]",
        "transition-[opacity,scale] duration-300 ease-[var(--ease-out-expo)]",
        on ? "scale-100 opacity-100" : "scale-[0.97] opacity-0",
      )}
    >
      <div
        className={cn(
          "flex size-14 items-center justify-center rounded-2xl bg-brand text-brand-foreground shadow-[0_12px_32px_-8px_var(--brand)]",
          "transition-[scale,translate] duration-500 ease-[var(--ease-spring)]",
          on ? "translate-y-0 scale-100" : "translate-y-2 scale-75",
        )}
      >
        <Icon
          className={cn(
            "size-6",
            filled && "translate-x-px fill-current",
            on && "animate-[drop-bob_1.6s_ease-in-out_infinite_0.4s]",
          )}
        />
      </div>
    </div>
  );
}
