// Canonical county coverage — the UI dropdowns read from here so they always match what we scrape,
// even before leads are promoted into the CRM. Add a county here the moment its scraper goes live.

// Every Central FL county Deal Finder covers (CRM / all-deals filters show these).
export const COVERED_COUNTIES = ["Orange", "Seminole", "Lake", "Polk", "Volusia", "Brevard", "Osceola"] as const;

// RealForeclose auction counties (Auctions tab filter).
export const AUCTION_COUNTIES = ["Orange", "Seminole", "Volusia", "Polk"] as const;

// Counties with a LIVE, verified pre-foreclosure scraper (the "scan this county" dropdown). Grow as verified.
export const PREFORECLOSURE_COUNTIES = ["Orange", "Seminole", "Lake", "Brevard", "Volusia", "Osceola", "Polk"] as const;

// Filter-dropdown helper: canonical list unioned with whatever counties are actually present in the data.
export const countyOptions = (present: (string | null | undefined)[] = []) => {
  const set = new Set<string>(COVERED_COUNTIES as readonly string[]);
  for (const c of present) if (c) set.add(c);
  return ["All", ...Array.from(set)];
};
