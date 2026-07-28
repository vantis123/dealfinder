"use client";

import { useEffect, useState, useCallback } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
import { Settings2, MapPin, Clock, Loader2, Check, Save } from "lucide-react";
import { PREFORECLOSURE_COUNTIES } from "@/lib/counties";

const DAY_PRESETS = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays only" },
  { value: "mon,wed,fri", label: "Mon / Wed / Fri" },
];

export default function SettingsPage() {
  const [s, setS] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch("/api/settings"); if (r.ok) setS(await r.json()); }
    catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = (county: string) => {
    setS((p: any) => {
      const set = new Set<string>(p.enabled_counties || []);
      set.has(county) ? set.delete(county) : set.add(county);
      return { ...p, enabled_counties: Array.from(set) };
    });
  };

  async function save() {
    setSaving(true); setSaved(false);
    try {
      const r = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled_counties: s.enabled_counties, scan_time: s.scan_time,
          scan_days: s.scan_days, timezone: s.timezone,
        }),
      });
      if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 2500); }
    } catch {} finally { setSaving(false); }
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 lg:ml-64">
        <Header title="Settings" />
        <div className="mx-auto max-w-3xl p-6 space-y-6">
          <p className="text-sm text-muted-foreground">
            Control the daily scanner — which counties it checks and when it runs. Changes apply on the next scheduled scan.
          </p>

          {loading || !s ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading settings…</div>
          ) : (
            <>
              {/* Counties to scan */}
              <Card className="p-5">
                <div className="mb-3 flex items-center gap-2">
                  <MapPin className="h-5 w-5 text-primary" />
                  <h2 className="font-bold">Counties to scan</h2>
                  <span className="text-xs text-muted-foreground">{(s.enabled_counties || []).length} of {PREFORECLOSURE_COUNTIES.length} on</span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {PREFORECLOSURE_COUNTIES.map((c) => {
                    const on = (s.enabled_counties || []).includes(c);
                    return (
                      <button key={c} onClick={() => toggle(c)}
                        className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors ${on ? "border-primary/50 bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:bg-accent"}`}>
                        <span>{c}</span>
                        <span className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${on ? "justify-end bg-primary" : "justify-start bg-muted"}`}>
                          <span className="h-4 w-4 rounded-full bg-white" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Card>

              {/* Schedule */}
              <Card className="p-5">
                <div className="mb-3 flex items-center gap-2">
                  <Clock className="h-5 w-5 text-primary" />
                  <h2 className="font-bold">Scan schedule</h2>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">Run at</span>
                    <input type="time" value={s.scan_time || "07:00"} onChange={(e) => setS({ ...s, scan_time: e.target.value })}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">Days</span>
                    <select value={s.scan_days || "daily"} onChange={(e) => setS({ ...s, scan_days: e.target.value })}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
                      {DAY_PRESETS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">Timezone</span>
                    <input value={s.timezone || "America/New_York"} onChange={(e) => setS({ ...s, timezone: e.target.value })}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                  </label>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  The daily scan runs each selected day at this time and pulls the new foreclosure filings for every county turned on above.
                </p>
              </Card>

              <div className="flex items-center gap-3">
                <button onClick={save} disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                  {saving ? "Saving…" : saved ? "Saved" : "Save settings"}
                </button>
                {s.updated_at && <span className="text-xs text-muted-foreground">last saved {new Date(s.updated_at).toLocaleString()}</span>}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
