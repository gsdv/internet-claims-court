import { useEffect, useState } from "react";
import Home from "./pages/Home";
import CaseView from "./pages/CaseView";
import type { Id } from "../convex/_generated/dataModel";

// Tiny path router: "/" and "/case/:id". Static hosting falls back to
// index.html for extension-less paths, so deep links work.
function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string) => {
    window.history.pushState({}, "", to);
    setPath(to);
  };
  return { path, navigate };
}

export default function App() {
  const { path, navigate } = usePath();
  const m = path.match(/^\/case\/([^/]+)/);
  return (
    <div className="min-h-screen">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
            className="flex items-baseline gap-3"
          >
            <span className="font-display text-2xl font-bold tracking-tight">
              Internet Claims Court
            </span>
            <span className="hidden text-xs uppercase tracking-[0.2em] text-ink-3 sm:inline">
              Evidence tried live
            </span>
          </a>
          <span className="font-mono text-xs text-ink-3">est. 2026</span>
        </div>
      </header>
      {m ? (
        <CaseView caseId={m[1] as Id<"cases">} navigate={navigate} />
      ) : (
        <Home navigate={navigate} />
      )}
    </div>
  );
}
