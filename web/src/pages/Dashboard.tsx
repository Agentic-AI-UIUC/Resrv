import { useQueues } from "../hooks/useQueues";
import { MachineColumn } from "../components/MachineColumn";

export function Dashboard() {
  const { queues, error, loading, refresh } = useQueues(3000);

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-[#13294B]">Live Queues</h2>
          <p className="text-sm text-gray-500">Real-time machine status</p>
        </div>
        <button
          onClick={refresh}
          className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-[#13294B] shadow-sm hover:bg-gray-50 hover:shadow transition-all duration-200 cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="flex justify-center py-20">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-[#E84A27]" />
        </div>
      )}

      {error && !loading && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center shadow-sm">
          <p className="font-semibold text-red-800">Failed to load queues</p>
          <p className="mt-1 text-sm text-red-600">{error}</p>
          <button
            onClick={refresh}
            className="mt-4 rounded-xl bg-[#E84A27] px-5 py-2 text-sm font-semibold text-white hover:bg-[#d4421f] shadow-sm cursor-pointer transition-all duration-200"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <div className="flex flex-wrap gap-5 justify-center lg:justify-start">
          {queues.map((q) => (
            <MachineColumn key={q.machine_id} queue={q} onRefresh={refresh} />
          ))}
        </div>
      )}
    </>
  );
}
