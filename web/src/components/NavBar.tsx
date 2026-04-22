import { Link, useLocation, useNavigate } from "react-router-dom";
import { ConnectionStatus } from "./ConnectionStatus";
import { useAuth } from "../auth/AuthContext";

export function NavBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { username, logout } = useAuth();

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
              {username && (
                <Link to="/analytics" className={linkClass("/analytics")}>
                  Analytics
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionStatus />
            {username ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">
                  Signed in as <span className="font-medium">{username}</span>
                </span>
                <button
                  onClick={() => {
                    logout();
                    navigate("/");
                  }}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Logout
                </button>
              </div>
            ) : (
              <Link
                to="/login"
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
              >
                Staff Login
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
