import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { initPwa } from "./pwa";

initPwa();

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
