import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const CommandMenu = lazy(async () => ({ default: (await import("./CommandMenu")).CommandMenu }));

interface PaletteCtx {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: boolean;
}

const Ctx = createContext<PaletteCtx | null>(null);

export function useCommandPalette(): PaletteCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCommandPalette must be inside CommandPaletteProvider");
  return ctx;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function overlayOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
  );
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === "k") {
        if (!isOpen && overlayOpen()) return;
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (isOpen || isEditable(event.target) || overlayOpen()) return;
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) setLoaded(true);
  }, [isOpen]);

  const value = useMemo(() => ({ open, close, toggle, isOpen }), [open, close, toggle, isOpen]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {(loaded || isOpen) && (
        <Suspense fallback={null}>
          <CommandMenu open={isOpen} onOpenChange={setOpen} />
        </Suspense>
      )}
    </Ctx.Provider>
  );
}

