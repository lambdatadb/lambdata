import type { SVGProps } from "react";
import { cn } from "./cn";

const GLYPH = {
  long: "M25.45 18.35L40.71 45.65",
  leg: "M33.08 32L23.69 45.89",
  nodes: [
    [22.82, 13.64],
    [43.34, 50.36],
    [20.66, 50.36],
  ] as const,
  head: [33.08, 32] as const,
};

function Glyph() {
  return (
    <>
      <g fill="none" stroke="currentColor">
        <path d={GLYPH.long} strokeWidth={4.75} />
        <path d={GLYPH.leg} strokeWidth={4.75} />
        {GLYPH.nodes.map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={5.4} strokeWidth={3.5} />
        ))}
      </g>
      <circle cx={GLYPH.head[0]} cy={GLYPH.head[1]} r={4.25} fill="currentColor" />
    </>
  );
}

export interface LogoProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  size?: number;
  tile?: boolean;
  label?: string;
}

export function Logo({ size = 24, tile = false, label, className, ...rest }: LogoProps) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  if (tile) {
    return (
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        className={cn("shrink-0 text-accent", className)}
        {...a11y}
        {...rest}
      >
        <rect width="64" height="64" rx="14" fill="rgb(var(--surface-inset))" />
        <rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="rgb(var(--edge-strong))" />
        <Glyph />
      </svg>
    );
  }
  return (
    <svg
      viewBox="5.49 5.49 53.02 53.02"
      width={size}
      height={size}
      className={cn("shrink-0 text-accent", className)}
      {...a11y}
      {...rest}
    >
      <Glyph />
    </svg>
  );
}

const wordmarkSizes = {
  sm: "text-body",
  md: "text-heading",
  lg: "text-title",
  xl: "text-display",
};

export interface WordmarkProps {
  size?: keyof typeof wordmarkSizes;
  className?: string;
}

export function Wordmark({ size = "md", className }: WordmarkProps) {
  return (
    <span className={cn("inline-flex items-baseline font-mono font-semibold leading-none tracking-[-0.05em]", wordmarkSizes[size], className)}>
      <span className="sr-only">LambData</span>
      <span aria-hidden className="text-text">
        lamb
      </span>
      <span aria-hidden className="text-text-muted">
        data
      </span>
    </span>
  );
}

const lockupSizes = {
  sm: { logo: 18, gap: "gap-2", word: "sm" as const },
  md: { logo: 22, gap: "gap-2.5", word: "md" as const },
  lg: { logo: 28, gap: "gap-3", word: "lg" as const },
  xl: { logo: 40, gap: "gap-3.5", word: "xl" as const },
};

export interface BrandMarkProps {
  size?: keyof typeof lockupSizes;
  tile?: boolean;
  className?: string;
}

export function BrandMark({ size = "md", tile = false, className }: BrandMarkProps) {
  const s = lockupSizes[size];
  return (
    <span className={cn("inline-flex items-center", s.gap, className)}>
      <Logo size={tile ? Math.round(s.logo * 1.3) : s.logo} tile={tile} />
      <Wordmark size={s.word} />
    </span>
  );
}
