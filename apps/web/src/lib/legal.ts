/**
 * The facts the legal pages state about who is behind this service.
 *
 * Kept here rather than written into three documents, because they change
 * together and a Privacy Policy naming a different entity from the Terms is
 * worse than either being vague.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  EVERY VALUE MARKED "TODO" MUST BE FILLED IN BEFORE TAKING PAYMENT.
 *
 *  These are not defaults. They are blanks. A privacy policy that does not
 *  identify its data controller, or terms with no governing law, are not
 *  merely incomplete - under GDPR Art. 13 the first is a compliance failure,
 *  and the second means a dispute is argued about *where* before it is argued
 *  about *what*. The pages render the placeholder text visibly so this cannot
 *  ship unnoticed.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface Operator {
  /** Legal entity or sole trader name — the data controller under GDPR. */
  entity: string;
  /** Postal address. Required for controller identification. */
  address: string;
  /** Where disputes are heard, e.g. "the courts of England and Wales". */
  jurisdiction: string;
  /** Reached for privacy requests and support. */
  email: string;
  /** The domain the service is served from. */
  site: string;
}

export const OPERATOR: Operator = {
  entity: "TODO — your legal entity or your own name",
  address: "TODO — your postal address",
  jurisdiction: "TODO — your country or state",
  email: "TODO — support@yourdomain.com",
  site: "TODO — yourdomain.com",
};

/** True while any blank is still a blank, so the pages can say so. */
export const OPERATOR_INCOMPLETE = Object.values(OPERATOR).some((v) =>
  v.startsWith("TODO")
);

/**
 * Bump when the substance changes, not when a typo is fixed.
 *
 * Terms and Privacy carry their own dates because they are amended for
 * different reasons - a new sub-processor changes one and not the other.
 */
export const TERMS_UPDATED = "6 August 2026";
export const PRIVACY_UPDATED = "6 August 2026";

/** What the free plan costs, and what the paid ones do. Mirrors core/tiers.py. */
export const PRICES = {
  pro: "$4.99",
  master: "$9.99",
} as const;

/** §17 recommends this, and it is short enough to state plainly. */
export const REFUND_DAYS = 14;

/**
 * How long things live after you ask for them to be gone. Mirrors
 * pipeline/purge.py, which is the code that actually does the deleting -
 * change one and change the other.
 */
export const RETENTION = {
  /** Soft-deleted accounts, before the nightly purge hard-deletes them. */
  accountDays: 30,
  /** Finished analysis jobs. */
  jobDays: 30,
  /** Revoked refresh tokens, kept only to detect token theft. */
  revokedTokenDays: 45,
  /** Engine evaluations, which are keyed by position and name nobody. */
  engineCacheDays: 180,
} as const;
