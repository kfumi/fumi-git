import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyMode, useTheme } from "./theme";
import "./index.css";

applyMode(useTheme.getState().mode);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
