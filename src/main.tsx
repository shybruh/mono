import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { Deck } from "./components/Deck";
import { useStore } from "./lib/store";
import "./index.css";

const view = new URLSearchParams(window.location.search).get("view");

function DeckRoot() {
  const init = useStore((s) => s.init);
  useEffect(() => {
    init({ library: false });
  }, [init]);
  return <Deck />;
}

// No browser context menu or reload shortcuts in a desktop app.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>{view === "deck" ? <DeckRoot /> : <App />}</StrictMode>,
);
