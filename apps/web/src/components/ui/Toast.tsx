import { AnimatePresence, motion } from "framer-motion";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { cn } from "./cn";

type Tone = "info" | "success" | "error";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

interface Ctx {
  show: (message: string, tone?: Tone) => void;
}

const ToastCtx = createContext<Ctx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, tone: Tone = "info") => {
    const id = Date.now() + Math.random();
    setToasts((cur) => [...cur, { id, message, tone }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 30 }}
              transition={{ type: "spring", stiffness: 320, damping: 28 }}
              className={cn(
                "card-surface shadow-raised flex items-center gap-2.5 px-4 py-3 text-body pointer-events-auto",
                t.tone === "success" && "border-success/40",
                t.tone === "error" && "border-danger/40",
              )}
            >
              {t.tone !== "info" && (
                <Icon
                  name={t.tone === "success" ? "check_circle" : "error"}
                  size={16}
                  className={t.tone === "success" ? "text-success" : "text-danger"}
                />
              )}
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): Ctx {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToast must be inside ToastProvider");
  return c;
}
