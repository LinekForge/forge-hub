let permissionGranted = false;

export function requestNotificationPermission(): void {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    permissionGranted = true;
    return;
  }
  if (Notification.permission !== "denied") {
    Notification.requestPermission().then((p) => {
      permissionGranted = p === "granted";
    });
  }
}

export function notify(title: string, body: string): void {
  if (!permissionGranted || !document.hidden) return;
  try {
    new Notification(title, { body: body.slice(0, 200) });
  } catch (err) {
    console.warn("[hub-dashboard] notification failed:", err);
  }
}
