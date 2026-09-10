import type { ReactNode } from "react";

export type Verdict =
  | "supported"
  | "mostly_supported"
  | "unresolved"
  | "misleading"
  | "unsupported";

export const VERDICT_LABEL: Record<Verdict, string> = {
  supported: "Supported",
  mostly_supported: "Mostly supported",
  unresolved: "Unresolved",
  misleading: "Misleading",
  unsupported: "Unsupported",
};

const VERDICT_STYLE: Record<Verdict, string> = {
  supported: "bg-for text-paper",
  mostly_supported: "bg-for/80 text-paper",
  unresolved: "bg-gold text-paper",
  misleading: "bg-against/85 text-paper",
  unsupported: "bg-against text-paper",
};

const VERDICT_DOT: Record<Verdict, string> = {
  supported: "bg-for",
  mostly_supported: "bg-for/70",
  unresolved: "bg-gold",
  misleading: "bg-against/70",
  unsupported: "bg-against",
};

export function verdictDot(verdict?: Verdict) {
  return verdict ? VERDICT_DOT[verdict] : "bg-line";
}

export function VerdictBadge({
  verdict,
  confidence,
  size = "md",
}: {
  verdict?: Verdict;
  confidence?: number;
  size?: "sm" | "md" | "lg";
}) {
  const sz =
    size === "lg"
      ? "px-4 py-2 text-base"
      : size === "sm"
        ? "px-2 py-0.5 text-[11px]"
        : "px-3 py-1 text-xs";
  if (!verdict)
    return (
      <span
        className={`inline-flex items-center gap-2 rounded-full border border-line bg-paper-2 font-mono uppercase tracking-wider text-ink-3 ${sz}`}
      >
        <span className="live-dot inline-block size-1.5 rounded-full bg-gold" />
        In session
      </span>
    );
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full font-mono uppercase tracking-wider ${VERDICT_STYLE[verdict]} ${sz}`}
    >
      {VERDICT_LABEL[verdict]}
      {confidence !== undefined && (
        <span className="opacity-80">{Math.round(confidence)}%</span>
      )}
    </span>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-[0.18em] text-ink-3">{label}</span>
      <span className={`font-display text-2xl font-semibold ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

export function timeAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
