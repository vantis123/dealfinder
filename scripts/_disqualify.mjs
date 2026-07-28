// Single source of truth for "this plaintiff is not a door-knock lead."
//
// WHY THIS FILE EXISTS: the HOA rule was implemented per-county and drifted. Orange
// (run-month.mjs) dropped HOA plaintiffs correctly; Seminole/Osceola/Polk/Lake routed them
// to manual_review instead, so 16 HOA cases reached foreclosure_leads. None were ever
// flagged (their spreads never cleared the bar), so nothing bad reached Dyer — but they
// are clutter the CRM should never see. Import from here instead of re-declaring regexes.
//
// THE RULE (Phillip): an HOA/condo-association foreclosure is a 2nd-position lien — no
// value sheet, no real equity to door-knock. Disqualify it.
//
// THE TRAP: banks are legally "National Association" — "U S BANK TRUST NATIONAL
// ASSOCIATION", "PNC BANK NATIONAL ASSOCIATION". A naive /assoc/ match nukes real
// first-position bank foreclosures. LENDER always wins over HOA.

export const HOA_RE =
  /homeowner|condominium|\bcondo\b|community (owners|assoc)|master assoc|owners association|\bvillas?\b|townhom|\bhoa\b|association resources|club vacations|flex vacations|property owners/i;

export const LENDER_RE =
  /\b(bank|mortgage|savings|lending|loan|financial|credit union|fund society|trust company|national association|n\.?a\.?|capital|servicing|federal home loan|freddie|fannie)\b/i;

/** True when the plaintiff is an HOA/association and NOT a lender. */
export function isDisqualifiedPlaintiff(plaintiff) {
  const p = (plaintiff || '').trim();
  if (!p) return false;                    // unknown plaintiff is a review case, not a disqualification
  if (LENDER_RE.test(p)) return false;     // lender wins — "NATIONAL ASSOCIATION" is a bank
  return HOA_RE.test(p);
}

// Postgres-flavoured mirror of the same rule, for the normalize step. Kept adjacent to the
// JS so the two can't drift the way the per-county copies did. \m and \M are word bounds.
export const SQL_HOA = `(plaintiff ~* '(homeowner|condominium|\\mcondo\\M|community (owners|assoc)|master assoc|owners association|\\mvillas?\\M|townhom|\\mhoa\\M|association resources|club vacations|flex vacations|property owners)'
   AND plaintiff !~* '\\m(bank|mortgage|savings|lending|loan|financial|credit union|fund society|trust company|national association|n\\.?a\\.?|capital|servicing|federal home loan|freddie|fannie)\\M')`;
