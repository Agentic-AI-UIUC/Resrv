const colours: Record<string, string> = {
  active: "bg-[#E84A27]/10 text-[#E84A27] border-[#E84A27]/20",
  maintenance: "bg-amber-100 text-amber-800 border-amber-200",
  offline: "bg-gray-100 text-gray-600 border-gray-200",
  waiting: "bg-[#13294B]/10 text-[#13294B] border-[#13294B]/20",
  serving: "bg-[#E84A27]/10 text-[#E84A27] border-[#E84A27]/20",
  completed: "bg-gray-100 text-gray-500 border-gray-200",
  cancelled: "bg-gray-100 text-gray-500 border-gray-200",
  no_show: "bg-red-100 text-red-700 border-red-200",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${colours[status] ?? "bg-gray-100 text-gray-600 border-gray-200"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
