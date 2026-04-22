import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Dashboard } from "./pages/Dashboard";
import { Analytics } from "./pages/Analytics";
import { Login } from "./pages/Login";

function RequireStaff({ children }: { children: React.ReactElement }) {
  const { username, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="py-12 text-center text-sm text-gray-500">Loading…</div>
    );
  }
  if (!username) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <div className="min-h-screen bg-gray-100">
          <NavBar />
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/login" element={<Login />} />
              <Route
                path="/analytics"
                element={
                  <RequireStaff>
                    <Analytics />
                  </RequireStaff>
                }
              />
            </Routes>
          </main>
          <footer className="py-6 text-center text-sm text-gray-400">
            Built by <span className="font-bold">Agentic AI @ UIUC</span>
          </footer>
        </div>
      </AuthProvider>
    </BrowserRouter>
  );
}
