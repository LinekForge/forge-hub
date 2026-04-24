import { useEffect, useRef } from "react";
import { useHubStore } from "../store";
import { fetchOverview, fetchHealthFallback } from "../api";
import type { PendingApproval } from "../types";
import { notify } from "../utils/notify";

export function usePolling(enabled = true) {
  const setInstances = useHubStore((s) => s.setInstances);
  const setChannelHealth = useHubStore((s) => s.setChannelHealth);
  const setPendingApprovals = useHubStore((s) => s.setPendingApprovals);
  const setHubInfo = useHubStore((s) => s.setHubInfo);
  const visibleRef = useRef(true);
  const prevApprovalsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!enabled) return;

    const onVisibility = () => {
      visibleRef.current = !document.hidden;
      if (visibleRef.current) poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    function pushNewApprovals(approvals: PendingApproval[]) {
      const prevIds = prevApprovalsRef.current;
      const newOnes = approvals.filter(a => !prevIds.includes(a.request_id));
      prevApprovalsRef.current = approvals.map(a => a.request_id);
      for (const a of newOnes) {
        notify("审批请求", `${a.tool_name}: ${a.description}`.slice(0, 100));
      }
    }

    async function poll() {
      if (!visibleRef.current) return;
      const data = await fetchOverview();
      if (data) {
        setInstances(data.instances);
        setChannelHealth(data.channels);
        setPendingApprovals(data.pending);
        setHubInfo(data.hub);
        pushNewApprovals(data.pending);
      } else {
        const fallback = await fetchHealthFallback();
        if (fallback) {
          setInstances(fallback.instances);
          setChannelHealth(fallback.channels);
          setPendingApprovals(fallback.pending);
          setHubInfo(fallback.hub);
          pushNewApprovals(fallback.pending);
        }
      }
    }

    poll();
    const id = setInterval(poll, 3000);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, setInstances, setChannelHealth, setPendingApprovals, setHubInfo]);
}
