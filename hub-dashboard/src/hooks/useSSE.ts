import { useEffect } from "react";
import { notify } from "../utils/notify";
import { useHubStore } from "../store";
import { apiUrl, getDashboardBearerToken } from "../api";

export function useSSE(enabled = true) {
  const hubToSessionMap = useHubStore((s) => s.hubToSessionMap);
  const isNativeApp = useHubStore((s) => s.isNativeApp);
  useEffect(() => {
    if (!enabled) return;

    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const clearRetry = () => {
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }
    };

    const closeStream = () => {
      es?.close();
      es = null;
    };

    const scheduleReconnect = () => {
      if (disposed || retryTimeout) return;
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        connect();
      }, 30_000);
    };

    const connect = () => {
      if (disposed) return;
      closeStream();

      try {
        const url = new URL(apiUrl("/homeland/stream"), window.location.href);
        const token = getDashboardBearerToken();
        if (token) url.searchParams.set("token", token);
        es = new EventSource(url.toString(), { withCredentials: false });
      } catch {
        scheduleReconnect();
        return;
      }

      es.addEventListener("connected", () => {
        clearRetry();
      });

      es.addEventListener("message", (e) => {
        try {
          const data = JSON.parse(e.data);
          const ts = data.ts ?? new Date().toISOString();
          const msg = {
            id: `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            dir: "in",
            text: data.content ?? "",
            time: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          };
          let contactId = data.fromInstance;
          if (isNativeApp && contactId && hubToSessionMap[contactId]) {
            contactId = hubToSessionMap[contactId];
          }
          if (contactId) {
            window.dispatchEvent(new CustomEvent("hub-new-message", {
              detail: { contactId, message: msg },
            }));
            notify(data.from ?? "agent", (data.content ?? "").slice(0, 100));
          }
        } catch (err) {
          console.warn("[hub-dashboard] SSE message parse failed:", err);
        }
      });

      es.addEventListener("approval", (e) => {
        try {
          const data = JSON.parse(e.data);
          notify("审批请求", data.tool_name ?? "新审批");
        } catch (err) {
          console.warn("[hub-dashboard] SSE approval parse failed:", err);
        }
      });

      es.onerror = () => {
        closeStream();
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      closeStream();
      clearRetry();
    };
  }, [enabled, isNativeApp, hubToSessionMap]);
}
