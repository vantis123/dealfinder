import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkBasicAuth } from "./lib/auth.mjs";

// SECURITY GATE — every page and every /api/* route runs with the Supabase
// service-role key (RLS bypassed) and returns real owner PII (addresses, phones,
// skiptrace names) or can trigger paid scraper runs. Nothing here is public, so
// we gate the ENTIRE app behind HTTP Basic auth. The browser attaches the
// Authorization header to both page loads and same-origin fetch() calls
// automatically, so the dashboard keeps working once you log in.
//
// Fails CLOSED: if DEALFINDER_AUTH_USER / DEALFINDER_AUTH_PASS are unset, every
// request returns 401 (the DB is never exposed by misconfiguration).
export function middleware(req: NextRequest) {
  const user = process.env.DEALFINDER_AUTH_USER;
  const pass = process.env.DEALFINDER_AUTH_PASS;
  const authHeader = req.headers.get("authorization");

  if (checkBasicAuth(authHeader, user, pass)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="DealFinder", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

// Gate everything except Next.js build assets and the favicon. This deliberately
// includes /api/* and all pages.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
