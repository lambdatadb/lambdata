export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export const focusRingInset = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

export const controlFocus =
  "outline-none focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/20";

export const controlBase =
  "w-full rounded-md border border-border-input bg-bg-inset text-body text-text transition-colors duration-150 placeholder:text-text-subtle hover:border-border-control/60 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger/70 aria-[invalid=true]:focus-visible:ring-danger/25";

export const floatingSurface = "z-50 rounded-lg border border-border-strong bg-bg-overlay text-text shadow-raised";

export const floatingMotion =
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1";

export const menuItem =
  "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-body text-text outline-none transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-bg-hover data-[disabled]:opacity-45 [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-muted";

export const scrimMotion =
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";
