import { Link, useLocation } from "react-router-dom";
import { ConnectionStatus } from "./ConnectionStatus";

export function NavBar() {
  const { pathname } = useLocation();

  const linkClass = (path: string) =>
    `px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
      pathname === path
        ? "bg-indigo-100 text-indigo-700"
        : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
    }`;

  return (
    <header className="bg-white border-b border-gray-200 shadow-sm">
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                Reserv
              </h1>
              <p className="text-sm text-gray-500">SCD Queue Management</p>
            </div>
            <nav className="flex gap-1">
              <Link to="/" className={linkClass("/")}>
                Queues
              </Link>
              <Link to="/analytics" className={linkClass("/analytics")}>
                Analytics
              </Link>
            </nav>
          </div>
          <ConnectionStatus />
        </div>
      </div>
    </header>
  );
}
