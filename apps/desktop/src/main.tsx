import "@hatbot/web/styles.css";
import "./app.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Banner, Computer, Main } from "./pages";

const label = getCurrentWindow().label;
if (label === "banner") document.documentElement.classList.add("banner-window");

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      {label === "banner" ? <Banner /> : label === "computer" ? <Computer /> : <Main />}
    </StrictMode>,
  );
