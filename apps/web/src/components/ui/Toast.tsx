import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Toaster as Sonner, toast as sonner, type ExternalToast } from "sonner";
import { buttonVariants } from "./Button";
import { Spinner } from "./Spinner";
import { cn } from "./cn";

export type ToastTone = "info" | "success" | "error" | "warning";

export interface ToastOptions {
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  id?: string | number;
  duration?: number;
}

const durations: Record<ToastTone, number> = {
  info: 4000,
  success: 4000,
  warning: 7000,
  error: 9000,
};

function toExternal(tone: ToastTone, options?: ToastOptions): ExternalToast {
  return {
    id: options?.id,
    description: options?.description,
    duration: options?.duration ?? durations[tone],
    action: options?.action ? { label: options.action.label, onClick: options.action.onClick } : undefined,
  };
}

function show(message: ReactNode, tone: ToastTone = "info", options?: ToastOptions): string | number {
  const external = toExternal(tone, options);
  if (tone === "success") return sonner.success(message, external);
  if (tone === "error") return sonner.error(message, external);
  if (tone === "warning") return sonner.warning(message, external);
  return sonner.info(message, external);
}

export interface ToastApi {
  show: (message: ReactNode, tone?: ToastTone, options?: ToastOptions) => string | number;
  success: (message: ReactNode, options?: ToastOptions) => string | number;
  error: (message: ReactNode, options?: ToastOptions) => string | number;
  warning: (message: ReactNode, options?: ToastOptions) => string | number;
  info: (message: ReactNode, options?: ToastOptions) => string | number;
  loading: (message: ReactNode, options?: ToastOptions) => string | number;
  promise: typeof sonner.promise;
  dismiss: (id?: string | number) => void;
}

export const toast: ToastApi = {
  show,
  success: (message, options) => show(message, "success", options),
  error: (message, options) => show(message, "error", options),
  warning: (message, options) => show(message, "warning", options),
  info: (message, options) => show(message, "info", options),
  loading: (message, options) => sonner.loading(message, { id: options?.id, description: options?.description }),
  promise: sonner.promise,
  dismiss: (id) => {
    sonner.dismiss(id);
  },
};

const ToastCtx = createContext<ToastApi>(toast);

export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      closeButton
      visibleToasts={4}
      gap={8}
      offset={16}
      mobileOffset={12}
      containerAriaLabel="Notifications"
      icons={{
        success: <CircleCheck className="size-4 text-success" aria-hidden />,
        error: <CircleAlert className="size-4 text-danger" aria-hidden />,
        warning: <TriangleAlert className="size-4 text-warn" aria-hidden />,
        info: <Info className="size-4 text-info" aria-hidden />,
        loading: <Spinner decorative size="md" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: cn(
            "group pointer-events-auto relative flex w-full items-start gap-3 rounded-lg border border-border-strong bg-bg-overlay py-3 pl-3.5 pr-10 text-body text-text shadow-overlay",
            "sm:w-[22rem]",
          ),
          icon: "mt-0.5 flex size-4 shrink-0 items-center justify-center",
          content: "flex min-w-0 flex-1 flex-col gap-0.5",
          title: "font-medium leading-5 text-text",
          description: "text-label text-text-muted",
          error: "border-danger/40",
          warning: "border-warn/35",
          actionButton: cn(buttonVariants({ variant: "secondary", size: "xs" }), "ml-2 self-center"),
          cancelButton: cn(buttonVariants({ variant: "ghost", size: "xs" }), "self-center"),
          closeButton: cn(
            "absolute right-2 top-2.5 grid size-6 place-items-center rounded-md !bg-transparent !text-text-subtle transition-colors hover:!bg-bg-hover hover:!text-text",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          ),
        },
      }}
    />
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => toast, []);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <Toaster />
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastCtx);
}
