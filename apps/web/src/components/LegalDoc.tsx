"use client";

import Link from "next/link";
import { OPERATOR_INCOMPLETE } from "@/lib/legal";

/**
 * The chrome around Terms, Privacy and the credits page.
 *
 * One component for all three so they read as one document set rather than
 * three pages written on different days — the same measure, the same heading
 * scale, the same footer. Long-form prose is the only place in this app that
 * needs a reading column, so the typography lives here instead of in the
 * global stylesheet.
 */

interface Props {
  title: string;
  /** Rendered under the title: what this document is, in one line. */
  standfirst?: string;
  updated?: string;
  /**
   * Shown above the text on Terms and Privacy. The credits page is a
   * statement of fact about our dependencies and needs no such warning.
   */
  showDraftNotice?: boolean;
  children: React.ReactNode;
}

export default function LegalDoc({
  title,
  standfirst,
  updated,
  showDraftNotice,
  children,
}: Props) {
  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
      <header className="mb-8">
        <Link href="/" className="text-xs text-muted underline hover:text-ink">
          ← ChessRabbit
        </Link>
        <h1 className="mt-3 font-display text-3xl">{title}</h1>
        {standfirst && (
          <p className="mt-2 text-sm leading-relaxed text-muted">{standfirst}</p>
        )}
        {updated && (
          <p className="mt-2 font-mono text-[11px] text-muted">Last updated {updated}</p>
        )}
      </header>

      {/* Two different warnings, and they are not the same warning. The first
          is about the text; the second is about the blanks in it. */}
      {showDraftNotice && (
        <div className="mb-6 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-xs leading-relaxed">
          <strong>Plain-language draft.</strong> This document was written for
          this specific service and describes what it actually does, but it has
          not been reviewed by a lawyer. It is the starting point BLUEPRINT §3.3
          calls for, not a substitute for advice.
        </div>
      )}

      {OPERATOR_INCOMPLETE && (
        <div className="mb-6 rounded-lg border border-bad/40 bg-bad/10 px-4 py-3 text-xs leading-relaxed">
          <strong>Not ready to publish.</strong> The operator&rsquo;s legal name,
          address, contact email and governing jurisdiction are still
          placeholders — see <code className="font-mono">src/lib/legal.ts</code>.
          Fill them in before charging anyone.
        </div>
      )}

      <div className="legal">{children}</div>

      <footer className="mt-12 border-t border-ivory/[0.08] pt-4">
        <nav className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <Link href="/terms" className="hover:text-ink hover:underline">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-ink hover:underline">
            Privacy
          </Link>
          <Link href="/open-source" className="hover:text-ink hover:underline">
            Open source
          </Link>
          <Link href="/pricing" className="hover:text-ink hover:underline">
            Pricing
          </Link>
        </nav>
      </footer>
    </div>
  );
}
