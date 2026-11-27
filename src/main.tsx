import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, parseTheme } from "./lib/appearance";
import { store } from "./lib/storage";
import "./index.css";

applyTheme(parseTheme(store.get("theme")));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
