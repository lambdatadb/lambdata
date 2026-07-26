import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App";
import "./styles/globals.css";
import { initializeColorTheme } from "./lib/theme";

initializeColorTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
