"use client";

import Link from "next/link";
import LegalDoc from "@/components/LegalDoc";
import { OPERATOR, PRIVACY_UPDATED, RETENTION } from "@/lib/legal";

function V({ value }: { value: string }) {
  return value.startsWith("TODO") ? <span className="todo">{value}</span> : <>{value}</>;
}

/**
 * Every claim on this page was checked against the code before it was written:
 * the columns on `users`, what /me/export returns, what pipeline/purge.py
 * deletes and when, where the session token is kept, and which third parties
 * the API actually talks to. If any of that changes, this page is wrong until
 * it is changed too.
 */
export default function PrivacyPage() {
  return (
    <LegalDoc
      title="Privacy Policy"
      standfirst="What we collect, why, who else sees it, and how to get rid of it."
      updated={PRIVACY_UPDATED}
      showDraftNotice
    >
      <h2>The short version</h2>
      <p>
        We collect the least we can get away with: an email address so you can
        log in, the chess you choose to store, and counters that enforce plan
        limits. <strong>There is no advertising, no analytics product, and no
        tracking of any kind on this site</strong> — not Google Analytics, not a
        pixel, not a third-party script. We do not sell or share your data, and
        we never see your card number.
      </p>

      <h2>Who is responsible</h2>
      <p>
        The data controller is{" "}
        <strong>
          <V value={OPERATOR.entity} />
        </strong>
        , of <V value={OPERATOR.address} />. For anything on this page, write to{" "}
        <V value={OPERATOR.email} />.
      </p>

      <h2>What we collect</h2>

      <h3>Because you gave it to us</h3>
      <ul>
        <li>
          <strong>Email address</strong> — to identify your account, verify it,
          and reset your password.
        </li>
        <li>
          <strong>Password</strong> — stored only as an Argon2id hash. We cannot
          read it, and neither can anybody who steals the database.
        </li>
        <li>
          <strong>Display name</strong> — optional, and shown to people you
          share a study with.
        </li>
        <li>
          <strong>Your chess</strong> — games you import, annotations and
          comments you write, studies and their chapters, collections,
          repertoires.
        </li>
        <li>
          <strong>Linked account usernames</strong> — if you connect a Lichess
          or Chess.com account to import your games, we store that username.
        </li>
      </ul>

      <h3>Because the service has to work</h3>
      <ul>
        <li>
          <strong>Plan and subscription status</strong>, mirrored from Stripe.
        </li>
        <li>
          <strong>Usage counters</strong> — how many analyses you have run
          today, and which days your account was active. These enforce free-plan
          limits and tell us how many people use the service. They count events,
          not behaviour: no record is kept of <em>which</em> positions you
          looked at.
        </li>
        <li>
          <strong>Puzzle rating</strong>, if you use the puzzle trainer.
        </li>
        <li>
          <strong>Session tokens</strong>, so you stay logged in.
        </li>
        <li>
          <strong>Server logs</strong> — including IP addresses, briefly, for
          rate limiting and to investigate abuse or faults.
        </li>
      </ul>

      <h3>What we do not collect</h3>
      <p>
        No cookies are used for tracking. Your session token is kept in your
        browser&rsquo;s <code>localStorage</code>, not in a cookie, and it is
        sent only to our own API. We do not build a profile of you, and we have
        no advertising relationship with anyone.
      </p>

      <h2>Why we are allowed to hold it</h2>
      <ul>
        <li>
          <strong>To perform our contract with you</strong> — your account, your
          games, your studies, your subscription. Without these the service
          cannot function.
        </li>
        <li>
          <strong>Our legitimate interests</strong> — rate limiting, abuse
          investigation, keeping the service up, and counting active users.
          These are narrow and we have kept them to what is necessary.
        </li>
        <li>
          <strong>Legal obligation</strong> — retaining payment records for tax
          and accounting.
        </li>
      </ul>

      <h2>Who else sees it</h2>
      <p>We use a small number of processors, each for one job:</p>
      <ul>
        <li>
          <strong>Stripe</strong> — payments and subscriptions. Stripe receives
          your email address and handles your card details directly; those
          details never touch our servers.
        </li>
        <li>
          <strong>Our email provider</strong> — receives your address to deliver
          verification, password reset and billing messages. Nothing else.
        </li>
        <li>
          <strong>Our hosting provider</strong> — stores the database and runs
          the servers.
        </li>
      </ul>
      <p>
        Two services are contacted <em>on your instruction</em> rather than
        given your data: when you connect a Lichess or Chess.com account we ask
        their public API for the games of the username you entered, and the
        opening explorer can query Lichess&rsquo;s public explorer with a chess
        position. Neither request identifies you.
      </p>
      <p>
        We do not sell your data, and we do not share it for anybody
        else&rsquo;s marketing. We would disclose data if the law required it,
        and would tell you unless prohibited from doing so.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          <strong>Your account and content</strong> — until you delete it.
          Deletion takes effect immediately for access, and everything is
          permanently erased {RETENTION.accountDays} days later. The delay is a
          grace period so an accidental deletion can be reversed.
        </li>
        <li>
          <strong>Revoked login tokens</strong> —{" "}
          {RETENTION.revokedTokenDays} days. These are kept deliberately: a
          revoked token being presented again is how stolen credentials are
          detected.
        </li>
        <li>
          <strong>Analysis job records</strong> — {RETENTION.jobDays} days.
        </li>
        <li>
          <strong>Server logs</strong> — a short rolling window, then discarded.
        </li>
        <li>
          <strong>Payment records</strong> — as long as tax law requires,
          which is longer than your account may last.
        </li>
      </ul>
      <p>
        One thing deliberately outlives your account: <strong>cached engine
        evaluations</strong>. These are stored against a chess position, not
        against a person — the row records a position, a depth and a score, and
        contains nothing that identifies who asked. They are what makes analysis
        fast and cheap for everyone, and they are kept for around{" "}
        {RETENTION.engineCacheDays} days regardless of who requested them. The
        same is true of the public reference database, which is public-domain
        data and never contained anything about you.
      </p>

      <h2>Your rights</h2>
      <p>
        If you are in the UK or EU, the GDPR gives you the rights below; we
        extend them to everyone regardless of where you live.
      </p>
      <ul>
        <li>
          <strong>Get a copy</strong> — the app exports your account details and
          every game you have stored, on demand.
        </li>
        <li>
          <strong>Correct it</strong> — edit your display name and game metadata
          in the app; email us for anything else.
        </li>
        <li>
          <strong>Delete it</strong> — delete your account in the app, which
          erases everything after the grace period above.
        </li>
        <li>
          <strong>Object or restrict</strong> — tell us and we will stop, unless
          we are required to keep something.
        </li>
        <li>
          <strong>Complain</strong> — to your local data protection authority.
          We would rather you told us first.
        </li>
      </ul>
      <p>
        Requests are answered within 30 days and cost nothing. We may ask you to
        confirm you control the account&rsquo;s email address.
      </p>

      <h2>Security</h2>
      <ul>
        <li>Passwords are hashed with Argon2id and never stored in the clear.</li>
        <li>
          Sessions use short-lived access tokens with rotating refresh tokens,
          and reuse of a revoked token is treated as theft.
        </li>
        <li>All traffic is served over HTTPS.</li>
        <li>The chess engine runs isolated from the application database.</li>
      </ul>
      <p>
        No system is perfectly secure. If we discover a breach affecting your
        data, we will tell you and the relevant authority without undue delay.
      </p>

      <h2>Children</h2>
      <p>
        The service is not intended for children under 13 (or under 16 where
        local law sets that bar), and we do not knowingly collect their data. If
        you believe a child has an account here, email us and we will remove it.
      </p>

      <h2>Where your data lives</h2>
      <p>
        Our servers are in <V value={OPERATOR.jurisdiction} />. Stripe and our
        email provider may process data outside your country under the safeguards
        their own agreements provide.
      </p>

      <h2>Changes</h2>
      <p>
        If we change how we handle your data in a way that affects you, we will
        email you before it takes effect. Smaller corrections are marked by the
        date at the top of this page.
      </p>

      <p>
        See also the <Link href="/terms">Terms of Service</Link> and our{" "}
        <Link href="/open-source">open-source credits</Link>.
      </p>
    </LegalDoc>
  );
}
