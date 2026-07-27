"use client";

import { useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, MapPin, Send, Sparkles } from "lucide-react";
import { COVERED_COUNTIES } from "@/lib/counties";

function RequestCounty() {
  const [state, setState] = useState("FL");
  const [county, setCounty] = useState("");
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function submit() {
    if (!county.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/county-requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, county, contact, notes }),
      });
      const d = await res.json();
      if (res.ok) { setStatus("done"); setMsg(d.message || "Got it — we'll build your county and email you when it's live."); setCounty(""); setContact(""); setNotes(""); }
      else { setStatus("error"); setMsg(d.error || "Something went wrong."); }
    } catch { setStatus("error"); setMsg("Couldn't submit — try again."); }
  }

  if (status === "done") {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
        <Check className="mx-auto mb-2 h-8 w-8 text-emerald-400" />
        <p className="font-semibold">{msg}</p>
        <p className="mt-1 text-sm text-muted-foreground">Our team maps the county&apos;s records (property value + amount owed) so it computes equity just like the live ones — then we email you the moment it&apos;s ready.</p>
        <button onClick={() => setStatus("idle")} className="mt-4 text-sm font-medium text-primary hover:underline">Request another →</button>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <MapPin className="h-5 w-5 text-primary" />
        <h3 className="font-bold">Don&apos;t see your county? Request it.</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Tell us the county you want covered. Our team maps its records site — where the
        <b className="text-foreground"> value</b> and <b className="text-foreground">amount owed</b> live —
        builds and verifies it, and <b className="text-foreground">emails you the moment it&apos;s live</b>.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[80px_1fr]">
        <input value={state} onChange={(e) => setState(e.target.value)} maxLength={2} placeholder="ST"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm uppercase" />
        <input value={county} onChange={(e) => setCounty(e.target.value)} placeholder="County name (e.g. Hillsborough)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      </div>
      <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Your email — so we can tell you when it's live"
        className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
        placeholder="Anything else? Drop your county's court/clerk case-search + property-appraiser links if you have them — it helps us start faster. (Optional — if not, we'll find them.)" rows={3}
        className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      {status === "error" && <p className="mt-2 text-sm text-red-400">{msg}</p>}
      <button onClick={submit} disabled={status === "sending" || !county.trim()}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
        <Send className="h-4 w-4" /> {status === "sending" ? "Sending…" : "Request this county"}
      </button>
    </Card>
  );
}

export default function JoinPage() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 lg:ml-64">
        <Header title="Request a County" />

        <div className="mx-auto max-w-3xl p-6 space-y-6">
          {/* Hero */}
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-6">
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h1 className="text-xl font-bold">Add your county to DealFinder</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              DealFinder runs 24/7 on its own. If your county isn&apos;t covered yet, request it below —
              our team maps its foreclosure records, wires up the valuation, and verifies every field
              before it goes live. You&apos;ll get an <b className="text-foreground">email the moment your county is ready</b>.
            </p>
          </div>

          {/* Coverage */}
          <div>
            <p className="mb-2 text-sm text-muted-foreground">Counties live right now:</p>
            <div className="flex flex-wrap gap-1.5">
              {COVERED_COUNTIES.map((c) => (
                <Badge key={c} className="border-0 bg-primary/10 text-primary">{c}</Badge>
              ))}
            </div>
          </div>

          {/* Request-a-county */}
          <RequestCounty />
        </div>
      </main>
    </div>
  );
}
