import { Link, useLocation, useNavigate } from "react-router-dom";
import { ConnectionStatus } from "./ConnectionStatus";
import { useAuth } from "../auth/AuthContext";
import { runTour } from "../onboarding/runTour";

export function NavBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { username, role, logout } = useAuth();
  const isAdmin = role === "admin";

  const linkClass = (path: string) =>
    `px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
      pathname === path
        ? "bg-white/20 text-white shadow-sm"
        : "text-blue-200 hover:text-white hover:bg-white/10"
    }`;

  const inAdmin = pathname.startsWith("/admin");

  return (
    <header className="bg-[#13294B] shadow-lg">
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">
                Reserv
              </h1>
              <p className="text-xs text-blue-300">SCD Queue Management</p>
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
              {username && (
                <Link
                  to="/admin/machines"
                  className={
                    inAdmin
                      ? "px-3 py-1.5 rounded-lg text-sm font-medium bg-white/20 text-white shadow-sm"
                      : "px-3 py-1.5 rounded-lg text-sm font-medium text-blue-200 hover:text-white hover:bg-white/10 transition-all duration-200"
                  }
                >
                  Admin
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionStatus />
            {username ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-blue-100">
                  {username}
                  <span className="ml-1 text-xs text-blue-300">({role})</span>
                </span>
                <button
                  onClick={() => runTour(navigate, isAdmin)}
                  className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20 transition-all duration-200"
                  title="Replay the onboarding tour"
                >
                  Replay tour
                </button>
                <button
                  onClick={() => {
                    logout();
                    navigate("/");
                  }}
                  className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20 transition-all duration-200"
                >
                  Logout
                </button>
              </div>
            ) : (
              <Link
                to="/login"
                className="rounded-lg bg-[#E84A27] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#d4421f] shadow-sm transition-all duration-200"
              >
                Staff Login
              </Link>
            )}
          </div>
        </div>
        {inAdmin && username && (
          <nav className="mt-3 flex gap-1 border-t border-white/15 pt-3">
            <Link to="/admin/machines" className={linkClass("/admin/machines")}>
              Machines
            </Link>
            {isAdmin && (
              <Link to="/admin/staff" className={linkClass("/admin/staff")}>
                Staff
              </Link>
            )}
            {isAdmin && (
              <Link
                to="/admin/colleges"
                className={linkClass("/admin/colleges")}
              >
                Colleges
              </Link>
            )}
            <Link
              to="/admin/feedback"
              className={linkClass("/admin/feedback")}
            >
              Feedback
            </Link>
            {isAdmin && (
              <Link
                to="/admin/settings"
                className={linkClass("/admin/settings")}
              >
                Settings
              </Link>
            )}
          </nav>
        )}
      </div>
    </header>
  );
}
