import { useEffect } from "react";
import { reportPresence } from "../api";

export function usePresence(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    let active = true;
    const onVisibility = () => {
      active = !document.hidden;
      reportPresence(active);
    };
    document.addEventListener("visibilitychange", onVisibility);
    reportPresence(true);
    const id = setInterval(() => reportPresence(active), 30_000);
    return () => {
      clearInterval(id);
      reportPresence(false);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);
}
