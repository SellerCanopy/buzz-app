import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../../shared/styles/globals.css";
import { Standalone, standaloneClient } from "./Standalone";

const client = standaloneClient(location.origin);
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Standalone client={client} />
    </StrictMode>,
  );
