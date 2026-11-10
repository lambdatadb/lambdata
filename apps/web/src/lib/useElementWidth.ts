import { useCallback, useRef, useState } from "react";

export function useElementWidth<T extends HTMLElement = HTMLDivElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    setWidth(node.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(node);
    observer.current = ro;
  }, []);
  return [ref, width];
}
