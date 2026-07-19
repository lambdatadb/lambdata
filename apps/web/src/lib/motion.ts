import type { Transition, Variants } from "framer-motion";

export const spring: Transition = { type: "spring", stiffness: 320, damping: 30 };

export const dialogVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 12 },
  visible: { opacity: 1, scale: 1, y: 0, transition: spring },
  exit: { opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.14 } },
};

export const overlayVariants: Variants = {
  hidden: { opacity: 0, pointerEvents: "none" },
  visible: { opacity: 1, pointerEvents: "auto", transition: { duration: 0.18 } },
  exit: { opacity: 0, pointerEvents: "none", transition: { duration: 0.14 } },
};
