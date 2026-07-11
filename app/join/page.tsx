"use client";

import { useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Laptop, Download, Terminal, KeyRound, Clock, Copy, Check, ExternalLink, Cpu, MapPin, Send } from "lucide-react";
import { COVERED_COUNTIES } from "@/lib/counties";

const REPO = "https://github.com/vantis123/dealfinder";
const ZIP = "https://github.com/vantis123/dealfinder/archive/refs/heads/main.zip";
const GUIDE = "https://github.com/vantis123/dealfinder/blob/main/SCRAPER-SETUP.md";
const CLONE = "git clone https://github.com/vantis123/dealfinder\ncd dealfinder\nbash setup.sh";

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-background p-4 pr-12 text-sm font-mono leading-relaxed">{text}</pre>
      <button
        onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
        className="absolute right-2 top-2 rounded-md border border-border bg-card p-2 text-muted-foreground hover:text-foreground" title="Copy">
        {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Step({ n, icon: Icon, title, children }: { n: number; icon: any; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">{n}</div>
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <div className="pl-11 text-sm text-muted-foreground space-y-2">{children}</div>
    </Card>
  );
}

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
      if (res.ok) { setStatus("done"); setMsg(d.message || "Got it — we'll add it within 48 hours."); setCounty(""); setContact(""); setNotes(""); }
      else { setStatus("error"); setMsg(d.error || "Something went wrong."); }
    } catch { setStatus("error"); setMsg("Couldn't submit — try again."); }
  }

  if (status === "done") {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
        <Check className="mx-auto mb-2 h-8 w-8 text-emerald-400" />
        <p className="font-semibold">{msg}</p>
        <p className="mt-1 text-sm text-muted-foreground">Our team maps the county&apos;s records (property value + amount owed) so it computes equity just like the live ones.</p>
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
        Tell us the county you want covered. Our team goes through its records site, maps where the
        <b className="text-foreground"> value</b> and <b className="text-foreground">amount owed</b> live,
        and we add it — usually <b className="text-foreground">within 48 hours</b>.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[80px_1fr]">
        <input value={state} onChange={(e) => setState(e.target.value)} maxLength={2} placeholder="ST"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm uppercase" />
        <input value={county} onChange={(e) => setCounty(e.target.value)} placeholder="County name (e.g. Hillsborough)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      </div>
      <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Your name / email (optional — so we can tell you when it's live)"
        className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything else? (records site link, priority, etc.)" rows={2}
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
      <main className="flex-1 ml-64">
        <Header title="Add a Scanner" />

        <div className="mx-auto max-w-3xl p-6 space-y-6">
          {/* Hero */}
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-6">
            <div className="mb-2 flex items-center gap-2">
              <Laptop className="h-5 w-5 text-primary" />
              <h1 className="text-xl font-bold">Turn a Mac into a deal-finding machine</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Every Mac running the scanner checks the county foreclosure records each morning and adds
              new leads to <b className="text-foreground">this dashboard</b> — automatically, while it sits there.
              The more Macs on the network, the more counties get covered. Set it up once; it runs itself.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <a href={ZIP} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
                <Download className="h-4 w-4" /> Download the repo
              </a>
              <a href={REPO} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-accent">
                <ExternalLink className="h-4 w-4" /> View on GitHub
              </a>
            </div>
          </div>

          {/* Requirement */}
          <Card className="flex items-center gap-3 border-amber-500/30 bg-amber-500/5 p-4">
            <Cpu className="h-5 w-5 flex-shrink-0 text-amber-400" />
            <p className="text-sm">
              <b>You need an Apple-Silicon Mac</b> (M1/M2/M3/M4). The stealth browser has no Windows or
              Intel-Mac build right now — an M-series Mac is required for it to run.
            </p>
          </Card>

          {/* Steps */}
          <div className="space-y-3">
            <Step n={1} icon={Terminal} title="Download & install (≈10 min, one time)">
              <p>Open the <b>Terminal</b> app and paste this:</p>
              <Copyable text={CLONE} />
              <p>It installs everything — Node, the stealth browser, and the PDF tools. If it asks for your Mac password once (Homebrew), that&apos;s normal.</p>
            </Step>

            <Step n={2} icon={KeyRound} title="Add your keys">
              <p>You&apos;ll be sent a filled-in <code className="rounded bg-background px-1">.env</code> file (or the values to paste). Drop it into the <code className="rounded bg-background px-1">dealfinder</code> folder. That&apos;s what lets your Mac read the records and feed this dashboard.</p>
              <p>Test it with one run: <code className="rounded bg-background px-1">npm run daily</code> — you&apos;ll see it work, and new leads show up here.</p>
            </Step>

            <Step n={3} icon={Clock} title="Turn on the daily schedule">
              <p>One command makes it run every morning at 7 AM by itself:</p>
              <Copyable text="bash scripts/install-schedule.sh" />
              <p>Leave the Mac on (plugged in, lid can be closed). That&apos;s it — you&apos;re a scanner node. <b className="text-emerald-400">A Mac that&apos;s on right now starts working immediately.</b></p>
            </Step>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-card/40 p-4 text-sm">
            <span className="text-muted-foreground">Want the full step-by-step guide?</span>
            <a href={GUIDE} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
              SCRAPER-SETUP.md <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>

          {/* Coverage + request-a-county */}
          <div>
            <p className="mb-2 text-sm text-muted-foreground">Counties live right now:</p>
            <div className="mb-5 flex flex-wrap gap-1.5">
              {COVERED_COUNTIES.map((c) => (
                <Badge key={c} className="border-0 bg-primary/10 text-primary">{c}</Badge>
              ))}
            </div>
            <RequestCounty />
          </div>

          <p className="text-center text-xs text-muted-foreground">
            Runs on your computer, your internet — no servers. Leads land in the shared database, deduped
            automatically, so two Macs never create a double.
          </p>
        </div>
      </main>
    </div>
  );
}
