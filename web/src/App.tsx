import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { Dashboard } from "./pages/Dashboard";
import { Analytics } from "./pages/Analytics";

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-100">
        <NavBar />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/analytics" element={<Analytics />} />
          </Routes>
        </main>
        <footer className="py-6 text-center text-sm text-gray-400">
          Built by <span className="font-bold">Agentic AI @ UIUC</span>
        </footer>
      </div>
    </BrowserRouter>
  );
}
