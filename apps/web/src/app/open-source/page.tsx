import LegalDoc from "@/components/LegalDoc";

export default function Credits() {
  return <LegalDoc title="Open-source credits" standfirst="ChessRabbit is licensed under GPL-3.0.">
    <h2>Chess engines</h2>
    <p><a href="https://stockfishchess.org/">Stockfish</a> and <a href="https://lczero.org/">Leela Chess Zero</a> are GPL-3.0 projects. ChessRabbit communicates with them through UCI. Stockfish is installed through Debian in the Docker worker; Leela and other engines can be configured locally.</p>
    <h2>Libraries</h2>
    <p>The backend uses python-chess (GPL-3.0-or-later), FastAPI and SQLAlchemy (MIT). The interface uses Next.js, React and react-chessboard (MIT), and chess.js (BSD-2-Clause). PostgreSQL and Redis provide local storage and queues. See THIRD_PARTY_NOTICES.md and the dependency lockfiles for sources and license details.</p>
    <h2>Data</h2>
    <p>Your own PGN files work without an external database. Reference games, puzzles, engine networks and optional tablebases must be obtained separately under their respective licenses.</p>
    <p><a href="https://github.com/shivamjg101/chessrabbit/tree/codex/open-source-local-engines">Source code and contribution guide</a></p>
  </LegalDoc>;
}
