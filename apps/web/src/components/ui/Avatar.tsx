import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "./cn";

const avatarVariants = cva(
  "relative flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full border border-border-strong bg-bg-selected font-medium uppercase text-text",
  {
    variants: {
      size: {
        sm: "size-6 text-micro",
        md: "size-8 text-label",
        lg: "size-10 text-body",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export function initialsOf(name: string | null | undefined): string {
  const source = (name ?? "").trim();
  if (!source) return "?";
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? words[1]?.[0] ?? "" : "";
  return (first + second).toUpperCase() || "?";
}

export interface AvatarProps
  extends ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>,
    VariantProps<typeof avatarVariants> {
  src?: string | null;
  name?: string | null;
  alt?: string;
}

export const Avatar = forwardRef<ElementRef<typeof AvatarPrimitive.Root>, AvatarProps>(function Avatar(
  { className, size, src, name, alt, children, ...rest },
  ref,
) {
  return (
    <AvatarPrimitive.Root ref={ref} className={cn(avatarVariants({ size }), className)} {...rest}>
      {src && <AvatarPrimitive.Image src={src} alt={alt ?? name ?? ""} className="size-full object-cover" />}
      {children ?? (
        <AvatarPrimitive.Fallback delayMs={src ? 400 : 0} aria-label={name ?? undefined}>
          {initialsOf(name)}
        </AvatarPrimitive.Fallback>
      )}
    </AvatarPrimitive.Root>
  );
});

export const AvatarImage = AvatarPrimitive.Image;
export const AvatarFallback = AvatarPrimitive.Fallback;
