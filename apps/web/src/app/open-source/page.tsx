"use client";

import { useEffect, useState } from "react";
import LegalDoc from "@/components/LegalDoc";
import { API_URL } from "@/lib/api";

/**
 * Open-source credits (BLUEPRINT §3.1, §17).
 *
 * This page discharges an obligation rather than being a nicety, so its
 * contents are static. The API serves the same attribution at `/open-source`
 * for programmatic use, but a credits page that goes blank when the backend is
 * down is a credits page that is missing exactly when somebody is checking.
 *
 * The one thing fetched is the engine's build string, because the Dockerfile
 * installs whatever the latest official release was at build time and no
 * constant here could stay true. If the fetch fails the line degrades to the
 * general statement, which is accurate either way.
 */

interface Credit {
  name: string;
  license: string;
  role: string;
  href?: string;
  /** Why it is where it is — only where the licence made that a decision. */
  note?: string;
}

const SERVER_SIDE: Credit[] = [
  {
    name: "Stockfish",
    license: "GPL-3.0",
    role: "The chess engine behind every evaluation, move classification and accuracy score.",
    href: "https://github.com/official-stockfish/Stockfish",
    note:
      "Run as an unmodified official build, on our servers only, as a separate process communicating over UCI. It is never sent to your browser and never bundled into a download. Running a GPL program to provide a network service is not distribution, so no obligation to release our own source arises — but the licence, the source and the version belong on this page regardless, and here they are.",
  },
  {
    name: "python-chess",
    license: "GPL-3.0",
    role: "Server-side PGN parsing, position replay and Zobrist hashing.",
    href: "https://github.com/niklasf/python-chess",
    note: "Server-side only, for the same reason as Stockfish.",
  },
  {
    name: "FastAPI",
    license: "MIT",
    role: "The HTTP and WebSocket API.",
    href: "https://github.com/fastapi/fastapi",
  },
  {
    name: "SQLAlchemy",
    license: "MIT",
    role: "Database access.",
    href: "https://github.com/sqlalchemy/sqlalchemy",
  },
  {
    name: "PostgreSQL",
    license: "PostgreSQL License",
    role: "Every game, position index and account.",
    href: "https://www.postgresql.org/",
  },
  {
    name: "Redis",
    license: "RSALv2 / SSPLv1",
    role: "Job queue, evaluation streaming and rate limiting.",
    href: "https://github.com/redis/redis",
  },
];

const CLIENT_SIDE: Credit[] = [
  {
    name: "chess.js",
    license: "BSD-2-Clause",
    role: "Move legality, FEN and PGN handling in your browser.",
    href: "https://github.com/jhlywa/chess.js",
  },
  {
    name: "react-chessboard",
    license: "MIT",
    role: "The board itself, including the piece graphics it ships with.",
    href: "https://github.com/Clariity/react-chessboard",
  },
  {
    name: "React",
    license: "MIT",
    role: "The interface.",
    href: "https://github.com/facebook/react",
  },
  {
    name: "Next.js",
    license: "MIT",
    role: "Builds the site into static files.",
    href: "https://github.com/vercel/next.js",
  },
  {
    name: "Tailwind CSS",
    license: "MIT",
    role: "Styling.",
    href: "https://github.com/tailwindlabs/tailwindcss",
  },
];

const DATA: Credit[] = [
  {
    name: "Lichess open database",
    license: "CC0 1.0 (public domain)",
    role: "The reference games behind position search and the opening explorer.",
    href: "https://database.lichess.org",
  },
  {
    name: "Lichess Opening Explorer API",
    license: "Public API",
    role: "Queried live for master statistics on a position, when you choose that scope.",
    href: "https://lichess.org/api",
  },
];

function Section({ title, credits }: { title: string; credits: Credit[] }) {
  return (
    <>
      <h2>{title}</h2>
      <ul>
        {credits.map((c) => (
          <li key={c.name}>
            <strong>
              {c.href ? (
                <a href={c.href} target="_blank" rel="noreferrer noopener">
                  {c.name}
                </a>
              ) : (
                c.name
              )}
            </strong>{" "}
            <code>{c.license}</code> — {c.role}
            {c.note && <p className="mt-1 text-[0.92em] text-muted">{c.note}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}

export default function OpenSourcePage() {
  const [engine, setEngine] = useState<string | null>(null);

  useEffect(() => {
    // Best effort. The page is complete without it.
    fetch(`${API_URL}/open-source`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setEngine(d?.stockfish?.version ?? null))
      .catch(() => setEngine(null));
  }, []);

  return (
    <LegalDoc
      title="Open source"
      standfirst="ChessRabbit is built on other people's work. This is what, and under which licences."
    >
      <p>
        Everything below is used within its licence. Anything under a copyleft
        licence runs on our servers and is never shipped to your browser;
        everything sent to your browser is permissively licensed. That split is
        deliberate and is checked when a dependency is added.
      </p>

      <Section title="On our servers" credits={SERVER_SIDE} />

      <p>
        <strong>Engine version.</strong>{" "}
        {engine ? (
          <>
            This server is currently running <code>{engine}</code>.
          </>
        ) : (
          <>
            This server runs the latest official Stockfish release available
            when its container was built.
          </>
        )}{" "}
        The complete corresponding source for every official release is at{" "}
        <a
          href="https://github.com/official-stockfish/Stockfish"
          target="_blank"
          rel="noreferrer noopener"
        >
          github.com/official-stockfish/Stockfish
        </a>
        . We do not patch it.
      </p>

      <Section title="In your browser" credits={CLIENT_SIDE} />
      <Section title="Data" credits={DATA} />

      <h2>Not affiliated</h2>
      <p>
        ChessRabbit is not affiliated with, endorsed by, or connected to the
        Stockfish project, Lichess, Chess.com, or ChessBase. Their names are
        used only to describe what this software interoperates with.
      </p>

      <h2>Something missing?</h2>
      <p>
        If you maintain something we use and this page gets your project or its
        licence wrong, tell us and we will fix it.
      </p>
    </LegalDoc>
  );
}
