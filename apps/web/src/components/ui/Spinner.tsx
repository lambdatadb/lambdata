import { cn } from "./cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-4 rounded-full border-2 border-white/20 border-t-white animate-spin",
        className,
      )}
    />
  );
}
