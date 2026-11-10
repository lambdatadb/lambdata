import { useCallback, useEffect, useRef, useState } from "react";

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = active?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? document.body;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
  host.appendChild(area);
  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  area.focus({ preventScroll: true });
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  host.removeChild(area);
  if (previousRange && selection) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }
  active?.focus({ preventScroll: true });
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof window !== "undefined" && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return legacyCopy(text);
    }
  }
  return legacyCopy(text);
}

export type CopyState = "idle" | "copied" | "failed";

export function useCopyToClipboard(resetMs = 1800) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setState("idle");
  }, []);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      setState(ok ? "copied" : "failed");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), ok ? resetMs : resetMs * 2.5);
      return ok;
    },
    [resetMs],
  );

  return { state, copied: state === "copied", failed: state === "failed", copy, reset };
}
