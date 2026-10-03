import LegalDoc from "@/components/LegalDoc";

export default function Credits() {
  return <LegalDoc title="Open-source credits" standfirst="ChessRabbit is licensed under GPL-3.0." updated="3 October 2026">
    <h2>Chess engines</h2>
    <p><a href="https://stockfishchess.org/">Stockfish</a> is included with the Windows app and is licensed under GPL-3.0. <a href="https://lczero.org/">Leela Chess Zero</a> is optional and GPL-3.0-or-later. ChessRabbit communicates with engines through UCI.</p>
    <h2>Libraries</h2>
    <p>The backend uses python-chess, FastAPI and SQLAlchemy. The interface uses Next.js, React, react-chessboard and chess.js. PostgreSQL stores local data. See THIRD_PARTY_NOTICES.md, dependency lockfiles and packaged license folders for sources and license details.</p>
    <h2>Release source and notices</h2>
    <p>Public binary releases should include corresponding ChessRabbit source, license text, third-party notices, checksums and Stockfish source material. The release files are published beside the installer on GitHub.</p>
    <h2>Data</h2>
    <p>Your own PGN files work without an external database. Reference games, puzzles, engine networks and optional tablebases must be obtained separately under their respective licenses.</p>
    <p><a href="https://github.com/shivamjg101/chessrabbit">Source code and contribution guide</a></p>
  </LegalDoc>;
}
