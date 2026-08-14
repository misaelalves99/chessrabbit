"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAccessToken, EvalLine } from "@/lib/api";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000";

export interface EngineState {
  lines: EvalLine[];
  /**
   * The position `lines` describe.
   *
   * Not always the position on the board: the board waits for the cursor to
   * settle before asking, so for a moment after a move the lines still belong
   * to where you just were. Anything that reads a score into a record - or
   * turns a PV into SAN - has to key off this rather than off the board, or it
   * files the previous position's evaluation against the current one.
   */
  fen: string | null;
  depth: number;
  thinking: boolean;
  connected: boolean;
  error: string | null;
}

/**
 * Live engine analysis over WebSocket.
 *
 * The engine runs server-side (Stockfish, GPL-3.0) - the browser only ever
 * receives evaluation numbers, never engine code. See BLUEPRINT.md Section 3.
 */
export function useEngine() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnect = useRef(true);

  const [state, setState] = useState<EngineState>({
    lines: [],
    fen: null,
    depth: 0,
    thinking: false,
    connected: false,
    error: null,
  });

  const connect = useCallback(() => {
    const token = getAccessToken();
    if (!token) {
      setState((s) => ({ ...s, error: "Not signed in" }));
      return;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`${WS_URL}/ws/analysis?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setState((s) => ({ ...s, connected: true, error: null }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "queued":
          setState((s) => ({ ...s, thinking: true, error: null }));
          break;

        case "info":
          setState((s) => {
            // Replace the line with the same multipv index, keep others
            const next = s.lines.filter((l) => l.multipv !== msg.multipv);
            next.push({
              depth: msg.depth,
              multipv: msg.multipv,
              cp: msg.cp,
              mate: msg.mate,
              pv: msg.pv ?? [],
            });
            next.sort((a, b) => a.multipv - b.multipv);
            return { ...s, lines: next, depth: Math.max(s.depth, msg.depth) };
          });
          break;

        case "done":
          setState((s) => ({
            ...s,
            thinking: false,
            depth: msg.depth ?? s.depth,
            lines: msg.lines ?? s.lines,
          }));
          break;

        case "stopped":
          setState((s) => ({ ...s, thinking: false }));
          break;

        case "error":
          setState((s) => ({ ...s, thinking: false, error: msg.message }));
          break;
      }
    };

    ws.onclose = (event) => {
      // 4401 (bad token) and 4429 (plan's live-board limit) are decisions, not
      // blips: the same socket will be refused every time, so retrying every
      // 2s just hammers the API — noticeably so with a second tab open, which
      // is exactly what trips 4429. Surface the reason and stay down.
      const refused = event.code === 4401 || event.code === 4429;
      if (refused) shouldReconnect.current = false;

      setState((s) => ({
        ...s,
        connected: false,
        thinking: false,
        error: refused ? event.reason || "Engine connection refused" : s.error,
      }));

      if (shouldReconnect.current) {
        reconnectRef.current = setTimeout(connect, 2000);
      }
    };

    ws.onerror = () => {
      setState((s) => ({ ...s, error: "Connection error" }));
    };
  }, []);

  useEffect(() => {
    shouldReconnect.current = true;
    connect();
    return () => {
      shouldReconnect.current = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const analyse = useCallback((fen: string, depth = 22, multipv = 3) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    setState((s) => ({ ...s, lines: [], fen, depth: 0, thinking: true, error: null }));
    ws.send(JSON.stringify({ op: "start", fen, depth, multipv }));
  }, []);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ op: "stop" }));
  }, []);

  return { ...state, analyse, stop };
}

/** Format a raw eval line for display: "+0.34", "-1.20", "M5". */
export function formatEval(line: EvalLine | undefined): string {
  if (!line) return "0.00";
  if (line.mate !== null && line.mate !== undefined) {
    return `M${Math.abs(line.mate)}`;
  }
  const pawns = (line.cp ?? 0) / 100;
  return (pawns >= 0 ? "+" : "") + pawns.toFixed(2);
}
