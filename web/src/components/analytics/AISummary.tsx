import { useState } from "react";
import type { MachineStat } from "../../api/types";

interface Props {
  machines: MachineStat[];
}

export function AISummary({ machines }: Props) {
  const [expanded, setExpanded] = useState(false);
  const summaries = machines.filter((m) => m.ai_summary);

  if (summaries.length === 0) return null;

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm border border-gray-200">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm font-medium text-gray-500 cursor-pointer w-full text-left"
      >
        <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>
          &#9654;
        </span>
        AI Summary
      </button>
      {expanded && (
        <div className="mt-3 space-y-2">
          {summaries.map((m) => (
            <div key={m.machine_id} className="text-sm text-gray-700">
              <span className="font-medium">{m.machine_name}:</span>{" "}
              {m.ai_summary}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
