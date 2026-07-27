"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * Secondary navigation.
 *
 * The header only has room for the handful of places you go every session;
 * everything else lives here rather than being cut. Every entry points at a
 * route that exists — a menu that lists things the app cannot do is worse than
 * a shorter menu.
 */
const GROUPS: {
  heading: string;
  items: { href: string; label: string; icon: string; blurb: string }[];
}[] = [
  {
    heading: "Train",
    items: [
      {
        href: "/train",
        label: "Opening drills",
        icon: "📚",
        blurb: "Spaced repetition on your repertoire",
      },
      {
        href: "/train/puzzles",
        label: "Puzzles",
        icon: "🧩",
        blurb: "Rated tactics and Puzzle Rush",
      },
      {
        href: "/train/intuition",
        label: "Intuition",
        icon: "🔮",
        blurb: "Guess the master's move",
      },
      {
        href: "/train/clock",
        label: "Time bank",
        icon: "⏱",
        blurb: "Drill your clock management",
      },
    ],
  },
  {
    heading: "Study",
    items: [
      {
        href: "/insights",
        label: "Insights",
        icon: "💡",
        blurb: "How you actually play, across every game",
      },
      {
        href: "/prep",
        label: "Opponent prep",
        icon: "🎯",
        blurb: "Scout what your next opponent plays",
      },
    ],
  },
  {
    heading: "Account",
    items: [
      {
        href: "/pricing",
        label: "Plans and pricing",
        icon: "★",
        blurb: "Compare what each tier unlocks",
      },
    ],
  },
];

export default function MoreMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Escape closes it, like every other menu on the platform.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`seg-item flex items-center gap-1 ${open ? "seg-item-on" : ""}`}
      >
        More
        <span
          aria-hidden
          className={`text-[9px] transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▼
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="card absolute left-0 top-full z-50 mt-2 w-72 animate-rise p-1.5 shadow-card"
          >
            {GROUPS.map((group, gi) => (
              <div
                key={group.heading}
                className={gi > 0 ? "mt-1 border-t border-white/[0.06] pt-1" : ""}
              >
                <p className="eyebrow px-2 py-1">{group.heading}</p>
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.07]"
                  >
                    <span aria-hidden className="mt-0.5 w-5 shrink-0 text-center text-base leading-none">
                      {item.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm">{item.label}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {item.blurb}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
