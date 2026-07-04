// County registry for DealFinder.
//   Orange   = LIVE end-to-end (reCAPTCHA via CapSolver, Camoufox).
//   Seminole = search form mapped (NoBot timing captcha — NO CapSolver needed); the results table,
//              docket page, and Complaint/Value document-link format are still PENDING discovery
//              (the teach-session walkthrough of the ASP.NET site). Until then daily.mjs skips it so
//              we never mislabel Orange data as Seminole.
//
// HOA rule (both counties): skip any plaintiff containing association / homeowner / condo / HOA —
// those are 2nd-position liens with no value sheet and no real equity to door-knock.

export const COUNTIES = {
  Orange: {
    id: 'orange',
    name: 'Orange County, FL',
    scraper: 'ready',
    engine: 'myeclerk',
    recordsPortal: 'https://myeclerk.myorangeclerk.com',
    caseSearchUrl: 'https://myeclerk.myorangeclerk.com/Cases/Search',
    captcha: { type: 'recaptcha-v2', sitekey: '6LdtOBETAAAAABvi0Md4UUqb7GKfkRiUR6AsrFX-' },
    // KEEP circuit civil (CA = bank, 1st position); DROP county civil (CC) + HOA/association plaintiffs.
    keepCourtType: /\bCA\b/i,
    dropCourtType: /\bCC\b/i,
    dropPlaintiff: /assoc|homeowner|condo|hoa/i,
    docs: { complaint: /complaint/i, valueOfProperty: /value of real property/i },
  },

  Seminole: {
    id: 'seminole',
    name: 'Seminole County, FL',
    // LIVE — validated end-to-end 2026-06-27 (multi-court 19L/20L+14H/14N, bank-only filter, Claude
    // address extraction). Scraper = scripts/run-seminole.mjs.
    scraper: 'ready',
    engine: 'aspnet',   // ASP.NET WebForms — postback search; the disclaimer + NoBot are auto-handled in-browser
    caseSearchUrl: 'https://courtrecords.seminoleclerk.org/civil/',
    // NoBot (AjaxControlToolkit) timing captcha — passes natively in a real browser after a human-like
    // pause before submit. No CapSolver, no token. Confirmed working.
    captcha: { type: 'nobot', strategy: 'realistic-delay-before-submit' },
    // One-time disclaimer modal — dismiss by clicking "Agree" inside #MainContent_disclaimer_container.
    disclaimer: { container: '#MainContent_disclaimer_container', acceptText: 'Agree' },
    form: {
      dateFrom: '#fromDateTxt',                 // M/D/YYYY  (this is the day/range filter for daily runs)
      dateTo: '#toDateTxt',
      caseNumber: '#caseNumberTxt',
      lastName: '#lastNameTxt',
      firstName: '#firstNameTxt',
      submit: '#search',                        // <input type=submit id=search>
    },
    // Foreclosures live in TWO bootstrap-multiselect groups — select both in one search (Phillip 2026-06-27).
    //   County court  (#countycollapse): 19L/20L  — mostly HOA liens, a few bank mortgages
    //   Circuit court (#circuitcollapse): 14H/14N — where the bank-mortgage volume actually is (US Bank, etc.)
    caseTypeGroups: [
      { select: '#countycollapse',  label: 'County',  codes: ['19L', '20L'] },
      { select: '#circuitcollapse', label: 'Circuit', codes: ['14H', '14N'] },
    ],
    foreclosureCodes: {
      '19L': 'Foreclosure (County)', '20L': 'Foreclosure (County)',
      '14H': 'Homestead/Residential (Circuit)', '14N': 'Non-Homestead/Residential (Circuit)',
    },
    doorKnockCodes: ['19L', '20L', '14H', '14N'], // flat union (banner/labels)
    // Results: table #CaseGrid; case rows link to civil_details.aspx?d=<token> (case # is the link text).
    results: { table: '#CaseGrid', caseLinkMatch: /civil_details\.aspx/i },
    // Docket page (civil_details.aspx): #PartyGrid (parties), #docketGrid (documents), #hearingGrid.
    //   HOA filter = check the PLAINTIFF row in #PartyGrid only (HOAs often appear as co-DEFENDANTS in
    //   real bank foreclosures — don't drop those). Drop only when the plaintiff matches.
    docket: { detailsUrl: /civil_details\.aspx/i, partyGrid: '#PartyGrid', docketGrid: '#docketGrid' },
    // BANK-ONLY mode (validated 2026-06-27: County 19L/20L is ~90% HOA liens). An "...ASSOCIATION" / HOA /
    // condo / homeowner / property-owners plaintiff is never a bank mortgage → drop it, UNLESS it also matches
    // bankPlaintiff (covers "BANK, NATIONAL ASSOCIATION"). This catches the "COMMUNITY SERVICES ASSOCIATION"
    // variants the old narrow regex missed.
    dropPlaintiff: /\bassociation\b|\bassoc\b|\bH\.?\s?O\.?\s?A\b|homeowner|condominium|\bcondo\b|property\s+owners|townhom\w*/i,
    // If the plaintiff looks like a bank/lender, it's NEVER an HOA (overrides dropPlaintiff).
    bankPlaintiff: /\bbank\b|national\s+association|\bN\.?\s?A\.?\b|mortgage|\bloan|\btrust\b|financ|federal|savings|servic|lender|credit\s+union|fargo|chase|citi|wells|fannie|freddie|rocket|nationstar|loandepot|carrington|newrez|freedom/i,
    // Government plaintiffs = code-enforcement / tax liens, not bank mortgages — skip (Phillip: bank-only).
    govPlaintiff: /^\s*seminole county\b|\bcity of\b|\bstate of florida\b|tax collector|code enforcement|clerk of\b/i,
    // Document codes in #docketGrid → the two we require (BOTH must be present to qualify):
    docCodes: { complaint: 'CMPL', valueOfProperty: 'VALU' },
    // Each docket row has a doc_view2.aspx?d=<token> link. To get the PDF (the viewer's own JS recipe):
    //   1. GET doc_view2.aspx?d=<token>  → HTML; extract  var id = '<base64>'
    //   2. GET civil_serv.asmx/getPDFImage?id=<JSON.stringify(id), url-encoded>
    //        header Content-Type: application/json; charset=utf-8
    //   3. response JSON { d: '<base64 pdf>' } → Buffer.from(d,'base64') = the PDF.
    //   Then reuse the Orange back-half: pdftotext(address) + OCR/Claude(owed) → Zillow → spread.
    docFetch: { viewer: 'doc_view2.aspx?d=', service: 'civil_serv.asmx/getPDFImage', idVar: /var\s+id\s*=\s*'([^']+)'/, responseKey: 'd' },
  },
  Lake: {
    id: 'lake',
    name: 'Lake County, FL',
    // LIVE — validated 2026-07-03 end-to-end (Circuit Civil foreclosure search → docket → Complaint+Value
    // PDFs → address(vision) + owed → bank-only filter). Scraper = scripts/run-lake.mjs (self-contained).
    scraper: 'ready',
    engine: 'showcase',   // equivant ShowCase SPA — search JSON has caseType+sid; docs via POST /sci/docket/document
    caseSearchUrl: 'https://courtrecords.lakecountyclerk.org/',
  },
  Volusia: {
    id: 'volusia',
    name: 'Volusia County, FL',
    // LIVE — validated 2026-07-03 (weekly foreclosure report → ccms.clerk.org docket → Complaint + Worksheet
    // PDFs → address + owed). No captcha. Scraper = scripts/run-volusia.mjs (self-contained).
    scraper: 'ready',
    engine: 'ccms',       // app02.clerk.org weekly reports + ccms.clerk.org ASP.NET docket/docs
    caseSearchUrl: 'https://ccms.clerk.org/',
  },
  Polk: {
    id: 'polk',
    name: 'Polk County, FL',
    // LIVE — validated 2026-07-03 (PRO public access: reCAPTCHA via CapSolver → Circuit-Civil UCN+date search
    // → docket → docs; address from Lis Pendens since the complaint is gated to pg1). Scraper = run-polk.mjs.
    scraper: 'ready',
    engine: 'pro',        // Polk Records Online (pro.polkcountyclerk.net/PRO); reCAPTCHA v2 (CapSolver)
    caseSearchUrl: 'https://pro.polkcountyclerk.net/PRO',
  },
  Osceola: {
    id: 'osceola',
    name: 'Osceola County, FL',
    // LIVE — validated 2026-07-03 (Pioneer Benchmark CSV export → docket → Complaint + Value PDFs →
    // address(vision) + owed). No captcha. Scraper = scripts/run-osceola.mjs (self-contained).
    scraper: 'ready',
    engine: 'benchmark',  // Pioneer Technology Group Benchmark at courts.osceolaclerk.com/BenchmarkWeb
    caseSearchUrl: 'https://courts.osceolaclerk.com/BenchmarkWeb',
  },
  Brevard: {
    id: 'brevard',
    name: 'Brevard County, FL',
    // LIVE — validated 2026-07-03 (BECA case-type foreclosure search → docket → Complaint + Mortgage Claim
    // Worksheet PDFs → address + owed). No captcha. Scraper = scripts/run-brevard.mjs (self-contained).
    scraper: 'ready',
    engine: 'beca',       // Brevard Electronic Court Application (ColdFusion); docs via get_document.cfm
    caseSearchUrl: 'https://vmatrix1.brevardclerk.us/beca/beca_splash.cfm',
  },
};

// Parse "Orange,Seminole" → ['Orange','Seminole']; default Orange.
export const parseCounties = (csv) =>
  (csv || 'Orange').split(',').map(s => s.trim()).filter(Boolean);

// Counties whose scraper is actually wired up (safe to run unattended).
export const readyCounties = (names) =>
  names.filter(n => COUNTIES[n]?.scraper === 'ready');
