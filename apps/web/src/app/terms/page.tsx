"use client";

import Link from "next/link";
import LegalDoc from "@/components/LegalDoc";
import { OPERATOR, PRICES, REFUND_DAYS, RETENTION, TERMS_UPDATED } from "@/lib/legal";

/** A blank from legal.ts, shown loudly rather than quietly. */
function V({ value }: { value: string }) {
  return value.startsWith("TODO") ? (
    <span className="todo">{value}</span>
  ) : (
    <>{value}</>
  );
}

export default function TermsPage() {
  return (
    <LegalDoc
      title="Terms of Service"
      standfirst="The agreement between you and us about using ChessRabbit."
      updated={TERMS_UPDATED}
      showDraftNotice
    >
      <h2>1. Who you are agreeing with</h2>
      <p>
        ChessRabbit (&ldquo;the service&rdquo;) is operated by{" "}
        <strong>
          <V value={OPERATOR.entity} />
        </strong>
        , of <V value={OPERATOR.address} /> (&ldquo;we&rdquo;, &ldquo;us&rdquo;).
        You can reach us at <V value={OPERATOR.email} />.
      </p>
      <p>
        By creating an account or using the service you accept these terms. If
        you do not accept them, do not use the service.
      </p>

      <h2>2. What the service is</h2>
      <p>
        ChessRabbit is a chess database and analysis platform. It stores games
        you import, analyses positions with a chess engine running on our
        servers, provides an opening explorer built from a public-domain game
        database, and lets you write and share annotated studies.
      </p>
      <p>
        It is not a chess server — you cannot play rated games against other
        people here — and it is not affiliated with ChessBase, Lichess,
        Chess.com, or the Stockfish project.
      </p>

      <h2>3. Your account</h2>
      <ul>
        <li>
          You must give a working email address. We use it to verify the
          account, to let you reset your password, and to send billing notices.
        </li>
        <li>
          You are responsible for what happens under your account. Keep your
          password to yourself, and tell us if you think somebody else has it.
        </li>
        <li>
          One person, one account. Sharing an account to share a subscription is
          not permitted.
        </li>
        <li>You must be old enough to enter a contract where you live.</li>
      </ul>

      <h2>4. Plans, billing and cancellation</h2>
      <p>
        There is a free plan with daily limits, and two paid plans:{" "}
        <strong>Pro</strong> at {PRICES.pro} per month and{" "}
        <strong>Master</strong> at {PRICES.master} per month. What each one
        includes is set out on the <Link href="/pricing">pricing page</Link>,
        which forms part of these terms.
      </p>
      <ul>
        <li>
          <strong>Payment is handled by Stripe.</strong> We never see or store
          your card number. Stripe&rsquo;s own terms apply to the payment
          itself.
        </li>
        <li>
          <strong>Subscriptions renew automatically</strong> each month or year
          until you cancel.
        </li>
        <li>
          <strong>You can cancel at any time</strong> from the billing portal
          linked in the app. Cancelling stops the next renewal; your paid
          features stay until the end of the period you have already paid for.
        </li>
        <li>
          <strong>Refunds:</strong> if you are unhappy within {REFUND_DAYS} days
          of a payment, email us and we will refund it, no questions asked. This
          is in addition to any statutory refund right you have where you live —
          it does not replace it.
        </li>
        <li>
          <strong>Prices can change</strong>, but not silently: we will tell you
          by email at least 30 days before a change affects you, and you can
          cancel before it takes effect.
        </li>
        <li>
          If a payment fails, we may suspend paid features until it is settled.
          Your data is not deleted for non-payment.
        </li>
      </ul>

      <h2>5. Your content</h2>
      <p>
        Games you import, annotations you write, and studies you build remain
        yours. We do not claim ownership of them.
      </p>
      <p>
        You give us permission to store, copy and process that content only so
        far as is needed to run the service for you — storing it, indexing
        positions so search works, running the engine over it when you ask, and
        showing it to people you deliberately share it with. That permission
        ends when you delete the content or your account.
      </p>
      <p>
        <strong>Sharing is your decision and it is real.</strong> A study set to
        &ldquo;anyone with the link&rdquo; can be opened by anybody who has that
        link, and a public study can be read by anyone. We cannot un-share
        something after somebody has seen it. You can reset a study&rsquo;s link
        at any time, which stops the old one working.
      </p>
      <p>
        You are responsible for having the right to upload what you upload. Game
        scores — the moves themselves — are generally not protectable, but
        published annotations and commentary usually are. Do not paste a book
        into a study.
      </p>

      <h2>6. Fair use of the engine</h2>
      <p>
        Engine analysis costs real CPU time, which is the main cost of running
        this service. Accordingly:
      </p>
      <ul>
        <li>
          Free accounts have daily limits, shown openly in the app rather than
          hidden until you hit them.
        </li>
        <li>
          Paid plans are &ldquo;unlimited&rdquo; in the ordinary sense — for one
          person analysing their own chess. They are not a licence to run an
          automated analysis farm.
        </li>
        <li>
          Do not script the API to bulk-analyse positions, scrape the reference
          database, resell access, or run the service on behalf of others.
        </li>
        <li>
          Do not use the service to cheat in a game that is being played
          anywhere else, at the time it is being played. This is the one rule we
          will terminate an account for without warning.
        </li>
      </ul>

      <h2>7. Things you must not do</h2>
      <ul>
        <li>Break the law, or use the service to help somebody else break it.</li>
        <li>
          Attempt to access accounts, data or systems that are not yours;
          probe, scan or overload the infrastructure.
        </li>
        <li>
          Upload malware, or content that is unlawful, harassing, or infringes
          somebody else&rsquo;s rights.
        </li>
        <li>
          Circumvent plan limits, rate limits, or the billing system.
        </li>
        <li>
          Resell, sublicense or white-label the service without our written
          agreement.
        </li>
      </ul>

      <h2>8. Availability</h2>
      <p>
        We aim to keep the service running and will not take it down casually,
        but we offer <strong>no uptime guarantee</strong>. This is a small
        operation on modest infrastructure. There will be maintenance, there
        will occasionally be outages, and engine analysis may queue at busy
        times.
      </p>
      <p>
        We may change, add or remove features. If we remove something you are
        paying for and you mind, tell us and we will refund the unused part of
        your period.
      </p>

      <h2>9. Engine evaluations are opinions</h2>
      <p>
        Analysis is produced by Stockfish, an unmodified official build running
        on our servers. Its evaluations, move classifications and accuracy
        scores are computational estimates, not facts. Do not rely on them for
        anything that matters beyond your own chess — in particular, they are
        not evidence of cheating by anybody.
      </p>

      <h2>10. Ending the agreement</h2>
      <p>
        You can delete your account at any time from the app. Doing so
        immediately removes access, and your data is permanently erased after{" "}
        {RETENTION.accountDays} days — the delay exists so an accidental
        deletion can be undone by contacting us within that window.
      </p>
      <p>
        We may suspend or terminate an account that breaks these terms. Where it
        is reasonable to do so, we will tell you why and give you a chance to
        put it right first; for serious breaches (section 6&rsquo;s cheating
        rule, or an attack on the infrastructure) we may act immediately. If we
        terminate a paid account for reasons that are not your fault, we refund
        the unused part of the period.
      </p>

      <h2>11. Liability</h2>
      <p>
        The service is provided as it is. To the fullest extent the law allows,
        we exclude implied warranties, and we are not liable for indirect or
        consequential loss, for lost profits, or for data loss where you had the
        ability to export your own data and did not.
      </p>
      <p>
        Where we are liable, our total liability is limited to what you paid us
        in the twelve months before the claim.
      </p>
      <p>
        Nothing here excludes liability that cannot lawfully be excluded —
        including death or personal injury caused by negligence, fraud, and any
        statutory consumer rights you have.
      </p>

      <h2>12. Changes to these terms</h2>
      <p>
        We may update these terms. For minor corrections we will change the date
        at the top. For changes that materially affect you, we will email you at
        least 30 days beforehand, and continuing to use the service after that
        means you accept them. If you do not, cancel — and if you had paid for a
        period you no longer want, we will refund the unused part.
      </p>

      <h2>13. Law and disputes</h2>
      <p>
        These terms are governed by the law of{" "}
        <V value={OPERATOR.jurisdiction} />, and disputes will be heard by its
        courts. If you are a consumer, this does not deprive you of the
        protection of the mandatory law of the country you live in.
      </p>
      <p>
        Please email us first at <V value={OPERATOR.email} />. Most things are
        settled in one message.
      </p>

      <h2>14. Odds and ends</h2>
      <ul>
        <li>
          If any part of these terms is unenforceable, the rest still stands.
        </li>
        <li>
          Not enforcing something once does not waive our right to enforce it
          later.
        </li>
        <li>
          You may not transfer your account to somebody else without our
          agreement.
        </li>
        <li>
          These terms and the <Link href="/privacy">Privacy Policy</Link> are
          the whole agreement between us about the service.
        </li>
      </ul>
    </LegalDoc>
  );
}
