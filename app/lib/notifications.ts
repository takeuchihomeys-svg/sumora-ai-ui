export async function registerSW(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch (e) {
    console.warn("SW registration failed:", e);
  }
}

export async function requestNotifPermission(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export async function showNotif(title: string, body: string, url = "/"): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const options: NotificationOptions = {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url },
  };

  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, options);
      return;
    } catch {
      // fallback
    }
  }
  new Notification(title, options);
}
