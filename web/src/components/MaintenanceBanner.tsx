import { useEffect, useState } from "react";
import { getPublicSettings } from "../api/admin";

export function MaintenanceBanner() {
  const [text, setText] = useState<string>("");

  useEffect(() => {
    async function tick() {
      try {
        const data = await getPublicSettings();
        setText(data.maintenance_banner ?? "");
      } catch {
        // swallow — banner is best-effort
      }
    }
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  if (!text) return null;
  return (
    <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
      {text}
    </div>
  );
}
