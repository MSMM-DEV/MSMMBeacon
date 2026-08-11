import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
// Single stylesheet entry. It declares the cascade layer order and pulls in
// Tailwind, the legacy styles.css, and the Beacon design tokens in the right
// order — nothing else in the app should import CSS directly.
import "./design/index.css";
import { initPwa } from "./pwa";

initPwa();

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
