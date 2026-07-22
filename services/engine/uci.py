"""
Stockfish UCI wrapper.

LICENSING NOTE (BLUEPRINT.md Section 3):
Stockfish is GPL-3.0. This module talks to an UNMODIFIED official Stockfish
binary as a separate process over stdin/stdout. The binary lives ONLY on the
server and is NEVER shipped to users. Do not vendor, patch, or compile
Stockfish into any client artifact.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from dataclasses import dataclass, field
from typing import AsyncIterator, Callable

log = logging.getLogger(__name__)


@dataclass
class EvalLine:
    """One MultiPV line of engine output, normalized."""

    depth: int
    multipv: int
    cp: int | None = None          # centipawns, side-to-move perspective
    mate: int | None = None        # mate in N (signed)
    pv: list[str] = field(default_factory=list)
    nodes: int | None = None
    nps: int | None = None

    def to_white_perspective(self, white_to_move: bool) -> "EvalLine":
        """Engine reports from side-to-move view. Storage is always White's view."""
        if white_to_move:
            return self
        return EvalLine(
            depth=self.depth,
            multipv=self.multipv,
            cp=-self.cp if self.cp is not None else None,
            mate=-self.mate if self.mate is not None else None,
            pv=self.pv,
            nodes=self.nodes,
            nps=self.nps,
        )

    def as_dict(self) -> dict:
        return {
            "depth": self.depth,
            "multipv": self.multipv,
            "cp": self.cp,
            "mate": self.mate,
            "pv": self.pv,
            "nodes": self.nodes,
            "nps": self.nps,
        }


def parse_info_line(line: str) -> EvalLine | None:
    """
    Parse a single UCI 'info' line by token scanning.

    UCI fields appear in arbitrary order and 'pv' runs to end of line, so a
    left-to-right token walk is the correct approach (regex is brittle here).
    Returns None for lines carrying no score (currmove, string, etc).
    """
    if not line.startswith("info"):
        return None

    tokens = line.split()
    depth = nodes = nps = None
    multipv = 1
    cp = mate = None
    pv: list[str] = []

    i = 1  # skip the literal "info"
    while i < len(tokens):
        tok = tokens[i]

        if tok == "depth" and i + 1 < len(tokens):
            depth = int(tokens[i + 1])
            i += 2
        elif tok == "seldepth" and i + 1 < len(tokens):
            i += 2  # parsed but unused; consume so the value isn't misread as a keyword
        elif tok == "multipv" and i + 1 < len(tokens):
            multipv = int(tokens[i + 1])
            i += 2
        elif tok == "nodes" and i + 1 < len(tokens):
            nodes = int(tokens[i + 1])
            i += 2
        elif tok == "nps" and i + 1 < len(tokens):
            nps = int(tokens[i + 1])
            i += 2
        elif tok == "score" and i + 2 < len(tokens):
            kind, value = tokens[i + 1], tokens[i + 2]
            if kind == "cp":
                cp = int(value)
            elif kind == "mate":
                mate = int(value)
            i += 3
        elif tok == "pv":
            pv = tokens[i + 1:]  # pv always runs to end of line
            break
        elif tok == "string":
            return None  # "info string ..." is free-form engine chatter
        else:
            i += 1

    if cp is None and mate is None:
        return None  # no evaluation in this line (e.g. currmove updates)

    return EvalLine(
        depth=depth or 0,
        multipv=multipv,
        cp=cp,
        mate=mate,
        pv=pv,
        nodes=nodes,
        nps=nps,
    )


class StockfishEngine:
    """
    Async wrapper around one Stockfish process.

    Usage:
        engine = StockfishEngine()
        await engine.start()
        async for line in engine.analyse(fen, depth=20, multipv=3):
            ...
        await engine.close()
    """

    def __init__(
        self,
        binary: str | None = None,
        threads: int = 2,
        hash_mb: int = 256,
    ) -> None:
        # Debian's package installs to /usr/games, which slim images omit from PATH.
        self.binary = (
            binary
            or os.getenv("STOCKFISH_PATH")
            or shutil.which("stockfish")
            or ("/usr/games/stockfish" if os.path.exists("/usr/games/stockfish") else "stockfish")
        )
        self.threads = threads
        self.hash_mb = hash_mb
        self.proc: asyncio.subprocess.Process | None = None
        self.version: str = "unknown"
        self._lock = asyncio.Lock()

    # ---------- process lifecycle ----------

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            self.binary,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await self._send("uci")
        while True:
            line = await self._readline()
            if line is None:
                raise RuntimeError("Stockfish died during handshake")
            if line.startswith("id name"):
                self.version = line[len("id name ") :].strip()
            if line.strip() == "uciok":
                break

        await self._send(f"setoption name Threads value {self.threads}")
        await self._send(f"setoption name Hash value {self.hash_mb}")
        await self._ready()
        log.info("Engine ready: %s (threads=%d hash=%dMB)", self.version, self.threads, self.hash_mb)

    async def close(self) -> None:
        if self.proc and self.proc.returncode is None:
            try:
                await self._send("quit")
                await asyncio.wait_for(self.proc.wait(), timeout=5)
            except (asyncio.TimeoutError, ConnectionResetError, BrokenPipeError):
                self.proc.kill()
        self.proc = None

    async def restart(self) -> None:
        """Engines crash. Supervisors must be boring and ruthless."""
        log.warning("Restarting engine process")
        await self.close()
        await self.start()

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    # ---------- low-level IO ----------

    async def _send(self, cmd: str) -> None:
        if not self.proc or not self.proc.stdin:
            raise RuntimeError("Engine not started")
        self.proc.stdin.write((cmd + "\n").encode())
        await self.proc.stdin.drain()

    async def _readline(self) -> str | None:
        if not self.proc or not self.proc.stdout:
            return None
        raw = await self.proc.stdout.readline()
        if not raw:
            return None
        return raw.decode(errors="replace").rstrip("\n")

    async def _ready(self) -> None:
        await self._send("isready")
        while True:
            line = await self._readline()
            if line is None:
                raise RuntimeError("Engine died waiting for readyok")
            if line.strip() == "readyok":
                return

    # ---------- analysis ----------

    async def analyse(
        self,
        fen: str,
        depth: int = 20,
        multipv: int = 1,
        movetime_ms: int | None = None,
        infinite: bool = False,
        stop_event: asyncio.Event | None = None,
        on_line: Callable[[EvalLine], None] | None = None,
        skill: int = 20,
    ) -> AsyncIterator[EvalLine | dict]:
        """
        Stream evaluation lines for a position.

        Yields EvalLine objects as they arrive, then a final
        {"type": "bestmove", "move": "e2e4"} dict.
        """
        async with self._lock:
            if not self.alive:
                await self.restart()

            await self._send(f"setoption name MultiPV value {max(1, multipv)}")
            # Always set Skill Level so a weakened play move never leaks into the
            # next full-strength analysis on this reused engine (20 = full).
            await self._send(f"setoption name Skill Level value {max(0, min(20, skill))}")
            await self._send("ucinewgame")
            await self._ready()
            await self._send(f"position fen {fen}")

            if infinite:
                await self._send("go infinite")
            elif movetime_ms:
                await self._send(f"go movetime {movetime_ms}")
            else:
                await self._send(f"go depth {depth}")

            stopped = False
            while True:
                if stop_event is not None and stop_event.is_set() and not stopped:
                    await self._send("stop")
                    stopped = True

                try:
                    line = await asyncio.wait_for(self._readline(), timeout=120)
                except asyncio.TimeoutError:
                    log.error("Engine read timeout; killing process")
                    await self.restart()
                    return

                if line is None:
                    log.error("Engine EOF; restarting")
                    await self.restart()
                    return

                if line.startswith("bestmove"):
                    parts = line.split()
                    yield {"type": "bestmove", "move": parts[1] if len(parts) > 1 else None}
                    return

                ev = parse_info_line(line)
                if ev is not None:
                    if on_line:
                        on_line(ev)
                    yield ev


class EnginePool:
    """A pool of Stockfish processes. Acquire/release with an async context manager."""

    def __init__(self, size: int = 3, threads: int = 2, hash_mb: int = 256) -> None:
        self.size = size
        self.threads = threads
        self.hash_mb = hash_mb
        self._queue: asyncio.Queue[StockfishEngine] = asyncio.Queue()
        self._engines: list[StockfishEngine] = []

    async def start(self) -> None:
        for _ in range(self.size):
            eng = StockfishEngine(threads=self.threads, hash_mb=self.hash_mb)
            await eng.start()
            self._engines.append(eng)
            await self._queue.put(eng)
        log.info("Engine pool started with %d processes", self.size)

    async def stop(self) -> None:
        for eng in self._engines:
            await eng.close()
        self._engines.clear()

    def acquire(self):
        pool = self

        class _Ctx:
            async def __aenter__(self) -> StockfishEngine:
                self.engine = await pool._queue.get()
                return self.engine

            async def __aexit__(self, *exc) -> None:
                await pool._queue.put(self.engine)

        return _Ctx()

    @property
    def version(self) -> str:
        return self._engines[0].version if self._engines else "unknown"
