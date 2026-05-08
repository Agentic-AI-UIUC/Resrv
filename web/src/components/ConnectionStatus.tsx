import { useEffect, useState } from "react";
import { fetchHealth } from "../api/client";

export function ConnectionStatus() {
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    async function check() {
      try {
        await fetchHealth();
        setConnected(true);
      } catch {
        setConnected(false);
      }
    }
    check();
    const id = setInterval(check, 10000);
    return () => clearInterval(id);
  }, []);

  if (connected === null) return null;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-[#E84A27] shadow-[0_0_6px_rgba(232,74,39,0.6)]" : "bg-red-400 animate-pulse shadow-[0_0_6px_rgba(248,113,113,0.6)]"}`}
      />
      <span className={connected ? "text-orange-200" : "text-red-300"}>
        {connected ? "Live" : "Offline"}
      </span>
    </div>
  );
}
