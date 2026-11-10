import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

const alertVariants = cva(
  "relative flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-body [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "border-border-strong bg-bg-raised text-text [&>svg]:text-text-muted",
        info: "border-info/30 bg-info/[0.06] text-text [&>svg]:text-info",
        success: "border-success/30 bg-success/[0.06] text-text [&>svg]:text-success",
        warning: "border-warn/35 bg-warn/[0.06] text-text [&>svg]:text-warn",
        danger: "border-danger/40 bg-danger/[0.07] text-text [&>svg]:text-danger",
      },
    },
    defaultVariants: { variant: "info" },
  },
);

const icons: Record<NonNullable<VariantProps<typeof alertVariants>["variant"]>, LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

export type AlertVariant = keyof typeof icons;

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  variant?: AlertVariant;
  title?: ReactNode;
  icon?: ReactNode | false;
  action?: ReactNode;
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { className, variant = "info", title, icon, action, children, role, ...rest },
  ref,
) {
  const DefaultIcon = icons[variant];
  return (
    <div
      ref={ref}
      role={role ?? (variant === "danger" ? "alert" : undefined)}
      className={cn(alertVariants({ variant }), className)}
      {...rest}
    >
      {icon === false ? null : icon ?? <DefaultIcon aria-hidden />}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="min-w-0 flex-[1_1_14rem] space-y-0.5">
          {title && <AlertTitle>{title}</AlertTitle>}
          {children && <AlertDescription>{children}</AlertDescription>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:-my-1">{action}</div>}
      </div>
    </div>
  );
});

export function AlertTitle({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("font-medium leading-5 text-text", className)} {...rest} />;
}

export function AlertDescription({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-body text-text-muted [&_a]:text-text [&_a]:underline [&_a]:underline-offset-2", className)} {...rest} />;
}
