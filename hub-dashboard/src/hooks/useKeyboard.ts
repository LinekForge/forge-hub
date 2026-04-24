import { useEffect } from "react";

interface KeyboardInstance {
  id: string;
}

interface UseKeyboardOptions {
  instances: KeyboardInstance[];
  onToggleMode: () => void;
  onSelectInstance: (id: string) => void;
}

export function useKeyboard({ instances, onToggleMode, onSelectInstance }: UseKeyboardOptions) {

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
        if (e.key === "Enter" && e.metaKey) return; // Cmd+Enter handled by Composer
        return;
      }

      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        onToggleMode();
        return;
      }

      if (e.metaKey && !e.shiftKey && e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key) - 1;
        if (idx < instances.length) {
          e.preventDefault();
          onSelectInstance(instances[idx].id);
        }
      }

      if (e.key === "Escape") {
        // future: close right panel
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [instances, onToggleMode, onSelectInstance]);
}
