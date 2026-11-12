import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@wpay/ui/styles.css";
import "./styles.css";
import { App } from "./app";

const container = document.getElementById("root");
if (!container) throw new Error("root element missing");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
