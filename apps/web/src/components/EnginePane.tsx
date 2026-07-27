"use client";

import { formatEval } from "@/hooks/useEngine";
import type { EvalLine } from "@/lib/api";

interface Props {
  lines: EvalLine[];
  depth: number;
  connected: boolean;
  thinking: boolean;
  error: string | null;
  autoAnalyse: boolean;
  onToggleAuto: (on: boolean) => void;
}

/** Live engine lines: the top candidate moves for the position on the board. */
export default function EnginePane({
  lines,
  depth,
  connected,
  thinking,
  error,
  autoAnalyse,
  onToggleAuto,
}: Props) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2 shrink-0">
          {connected && thinking && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent2/70" />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${
              connected ? "bg-accent2" : "bg-bad"
            }`}
          />
        </span>
        <span className="text-xs text-muted">
          {connected ? (thinking ? "Thinking…" : "Ready") : "Reconnecting…"}
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted">depth {depth}</span>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
          <input
            type="checkbox"
            className="accent-accent"
            checked={autoAnalyse}
            onChange={(e) => onToggleAuto(e.target.checked)}
          />
          Auto
        </label>
      </div>

      {error && <p className="text-xs text-bad">{error}</p>}

      <ol className="space-y-1">
        {lines.map((line, i) => (
          <li
            key={line.multipv}
            className="flex items-baseline gap-2 rounded-md px-1.5 py-1 hover:bg-white/[0.05]"
          >
            <span
              className={`w-12 shrink-0 font-mono text-xs font-semibold ${
                i === 0 ? "text-accent2" : "text-muted"
              }`}
            >
              {formatEval(line)}
            </span>
            <span className="truncate font-mono text-xs text-ink/70">
              {line.pv.slice(0, 8).join(" ")}
            </span>
          </li>
        ))}
        {lines.length === 0 && (
          <li className="px-1.5 py-1 text-xs text-muted">
            {connected ? "Analysing…" : "Waiting for the engine."}
          </li>
        )}
      </ol>
    </div>
  );
}
