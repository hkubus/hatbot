import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Dialogs } from "./confirm";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
      <Dialogs />
    </StrictMode>,
  );
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
