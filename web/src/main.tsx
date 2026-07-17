import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { WsProvider } from "@/hooks/use-ws";
import App from "./app";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <WsProvider>
        <App />
        <Toaster />
      </WsProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
