#!/usr/bin/env python3
"""
Generate realistic seed games for development by letting Stockfish play itself
from standard opening positions.

    sudo apt install stockfish
    python pipeline/generate_seed_games.py --games 60 --out seed.pgn
    python pipeline/load_reference_games.py seed.pgn --min-elo 2200

Why this exists: the opening explorer is useless when empty, and the real
Lichess dump is a multi-GB download you don't want in every dev environment.
Sixty engine games through the same loader give the explorer believable
statistics in about two minutes.

Production still uses the real dump - see README "Populating the opening
explorer". This is dev tooling only.
"""

from __future__ import annotations

import argparse
import random
import subprocess
import sys
from datetime import date, timedelta

import chess
import chess.engine

# Standard opening theory, 6-10 plies deep. Factual sequences, weighted
# roughly by real-world popularity so the explorer looks natural.
OPENINGS: list[tuple[str, str, list[str]]] = [
    ("C50", "Italian Game",        ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"]),
    ("C65", "Ruy Lopez, Berlin",   ["e4", "e5", "Nf3", "Nc6", "Bb5", "Nf6", "O-O", "Nxe4"]),
    ("C88", "Ruy Lopez, Closed",   ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7"]),
    ("B90", "Sicilian, Najdorf",   ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"]),
    ("B33", "Sicilian, Sveshnikov",["e4", "c5", "Nf3", "Nc6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "e5"]),
    ("B12", "Caro-Kann, Advance",  ["e4", "c6", "d4", "d5", "e5", "Bf5"]),
    ("C02", "French, Advance",     ["e4", "e6", "d4", "d5", "e5", "c5", "c3", "Nc6"]),
    ("D37", "QGD, Three Knights",  ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "Nf3", "Be7"]),
    ("D85", "Grunfeld, Exchange",  ["d4", "Nf6", "c4", "g6", "Nc3", "d5", "cxd5", "Nxd5", "e4", "Nxc3"]),
    ("E60", "King's Indian",       ["d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6"]),
    ("A20", "English, King's",     ["c4", "e5", "Nc3", "Nf6", "Nf3", "Nc6"]),
    ("D02", "London System",       ["d4", "d5", "Bf4", "Nf6", "e3", "e6", "Nf3", "c5"]),
]

FIRST = ["Adhikari", "Bakshi", "Chatterjee", "Deshmukh", "Iyer", "Joshi",
         "Kulkarni", "Mehta", "Nair", "Patil", "Rao", "Sharma", "Verma",
         "Fernandes", "Ghosh", "Reddy"]


def synthetic_player() -> tuple[str, int]:
    name = f"{random.choice(FIRST)}, {random.choice('ABCDEGKMNPRSV')}."
    elo = random.randint(2250, 2720)
    return name, elo


def play_game(engine: chess.engine.SimpleEngine, opening, rng: random.Random,
              max_plies: int, nodes: int) -> tuple[chess.Board, list[chess.Move], str]:
    eco, name, book = opening
    board = chess.Board()
    moves: list[chess.Move] = []

    for san in book:
        mv = board.parse_san(san)
        board.push(mv)
        moves.append(mv)

    while len(moves) < max_plies and not board.is_game_over(claim_draw=True):
        # multipv 3 + weighted choice = varied, human-ish games
        infos = engine.analyse(
            board, chess.engine.Limit(nodes=nodes), multipv=3,
        )
        candidates = [i["pv"][0] for i in infos if i.get("pv")]
        if not candidates:
            break
        weights = [0.72, 0.20, 0.08][: len(candidates)]
        mv = rng.choices(candidates, weights=weights, k=1)[0]

        board.push(mv)
        moves.append(mv)

        # adjudicate hopeless positions to keep games short
        score = infos[0]["score"].white()
        if score.is_mate():
            continue
        cp = score.score()
        if cp is not None and abs(cp) > 850 and len(moves) > 30:
            break

    if board.is_checkmate():
        result = "0-1" if board.turn == chess.WHITE else "1-0"
    elif board.is_game_over(claim_draw=True):
        result = "1/2-1/2"
    else:
        info = engine.analyse(board, chess.engine.Limit(nodes=nodes))
        cp = info["score"].white().score(mate_score=10000) or 0
        result = "1-0" if cp > 300 else "0-1" if cp < -300 else "1/2-1/2"

    return board, moves, result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=60)
    ap.add_argument("--out", default="seed.pgn")
    ap.add_argument("--nodes", type=int, default=6000, help="engine nodes per move")
    ap.add_argument("--max-plies", type=int, default=90)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--stockfish", default=None)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    binary = args.stockfish or subprocess.run(
        ["which", "stockfish"], capture_output=True, text=True
    ).stdout.strip() or "/usr/games/stockfish"

    try:
        engine = chess.engine.SimpleEngine.popen_uci(binary)
    except FileNotFoundError:
        sys.exit(f"Stockfish not found at {binary!r}. apt install stockfish")
    engine.configure({"Threads": 1, "Hash": 64})

    start_day = date(2024, 1, 6)
    with open(args.out, "w") as fh:
        for n in range(args.games):
            opening = rng.choices(
                OPENINGS,
                weights=[14, 10, 9, 12, 6, 7, 6, 8, 6, 8, 5, 9],
                k=1,
            )[0]
            board, moves, result = play_game(engine, opening, rng, args.max_plies, args.nodes)

            white, welo = synthetic_player()
            black, belo = synthetic_player()
            played = start_day + timedelta(days=rng.randint(0, 340))

            game = chess.pgn.Game()
            game.headers["Event"] = "Seed Invitational"
            game.headers["Site"] = "Dev"
            game.headers["Date"] = played.strftime("%Y.%m.%d")
            game.headers["White"] = white
            game.headers["Black"] = black
            game.headers["WhiteElo"] = str(welo)
            game.headers["BlackElo"] = str(belo)
            game.headers["Result"] = result
            game.headers["ECO"] = opening[0]
            game.headers["Opening"] = opening[1]

            node = game
            for mv in moves:
                node = node.add_variation(mv)

            print(game, file=fh)
            print("", file=fh)
            print(f"\r{n + 1}/{args.games} games ({opening[1]}, {len(moves)} plies, {result})",
                  end="", flush=True)

    engine.quit()
    print(f"\nwrote {args.games} games to {args.out}")


if __name__ == "__main__":
    import chess.pgn  # noqa: E402  (used above)
    main()
