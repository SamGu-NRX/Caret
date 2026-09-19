"use client";

import { useEffect, useState } from "react";

type Any = Record<string, any>;

const card: React.CSSProperties = { background: "#fff", border: "1px solid #e3e6ea", borderRadius: 10, padding: 16, marginBottom: 16 };
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, whiteSpace: "pre-wrap", background: "#f2f4f7", padding: 12, borderRadius: 8, overflowX: "auto" };
const pill = (bg: string): React.CSSProperties => ({ display: "inline-block", padding: "2px 8px", borderRadius: 999, background: bg, fontSize: 12, marginRight: 6 });

function AnswerTable({ answers }: { answers: Any }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <tbody>
        {Object.entries(answers).map(([id, a]: [string, any]) => (
          <tr key={id} style={{ borderTop: "1px solid #eee" }}>
            <td style={{ padding: "6px 4px", width: "40%" }}><code>{id}</code></td>
            <td style={{ padding: "6px 4px" }}>
              {a.type === "noul" || typeof a.noul === "number" ? <b>{a.noul.toFixed(2)}</b> : <b>{a.choice}</b>}
              {typeof a.confidence === "number" && <span style={{ color: "#667", marginLeft: 8 }}>conf {a.confidence.toFixed(2)}</span>}
              {a.probabilities && <span style={{ color: "#889", marginLeft: 8, fontSize: 12 }}>
                {Object.entries(a.probabilities).map(([k, v]: [string, any]) => `${k} ${(v * 100).toFixed(0)}%`).join(" · ")}
              </span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Page() {
  const [inputs, setInputs] = useState<Any | null>(null);
  const [result, setResult] = useState<Any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { fetch("/api/run").then((r) => r.json()).then(setInputs).catch((e) => setError(String(e))); }, []);

  async function run() {
    setBusy(true); setError(""); setResult(null);
    try {
      const r = await fetch("/api/run", { method: "POST" });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || r.statusText);
      setResult(json);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  }

  const icsHref = result?.ics ? `data:text/calendar;charset=utf-8,${encodeURIComponent(result.ics)}` : "";

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>Jev meeting scheduler</h1>
      <p style={{ color: "#556", marginTop: 0 }}>Sample email thread + sample computer history → skill questions → <b>Jev</b> decides what needs doing → code plans verified options → tentative holds.</p>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={run} disabled={busy} style={{ padding: "10px 18px", fontSize: 15, borderRadius: 8, border: 0, background: busy ? "#9aa" : "#1f6feb", color: "#fff", cursor: "pointer" }}>{busy ? "Running…" : "Run through Jev"}</button>
          {inputs && <span style={pill(inputs.mode === "live" ? "#d9f2e3" : "#fde8c8")}>Jev mode: {inputs.mode}</span>}
          {result && <span style={pill("#e7ebf5")}>status: {result.status}</span>}
        </div>
        {error && <p style={{ color: "#b00020" }}>{error}</p>}
      </div>

      {result && result.status === "scheduled" && (
        <div style={card}>
          <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>Scheduled (tentative holds)</h2>
          <p style={{ margin: "0 0 8px" }}>{result.summary}</p>
          <ul style={{ paddingLeft: 18 }}>
            {result.holds.map((h: Any) => <li key={h.option_id}>{h.proposed_first && <span style={pill("#d9f2e3")}>best</span>}{h.summary}<div style={{ color: "#667", fontSize: 12 }}>hold {h.start} → {h.end} · {h.status}</div></li>)}
          </ul>
          <a href={icsHref} download={`holds-${result.run_id}.ics`} style={{ display: "inline-block", padding: "8px 14px", borderRadius: 8, background: "#eef2ff", textDecoration: "none", color: "#1f3a8a" }}>Download .ics holds</a>
          {result.webhook && <span style={{ marginLeft: 12, fontSize: 13 }}>webhook {result.webhook.status}</span>}
          <p style={{ color: "#775", fontSize: 12 }}>{result.notice}</p>
        </div>
      )}

      {result && (result.status === "stopped" || result.status === "no_options") && (
        <div style={card}><h2 style={{ fontSize: 17, margin: "0 0 8px" }}>Not scheduled</h2><p>{result.reason}</p></div>
      )}

      {result?.extract_answers && (
        <div style={card}><h2 style={{ fontSize: 17, margin: "0 0 8px" }}>Pass 1 · Jev extraction <span style={{ color: "#889", fontSize: 12 }}>{result.model}</span></h2><AnswerTable answers={result.extract_answers} /></div>
      )}

      {result?.candidates && (
        <div style={card}>
          <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>Pass 2 · verified candidates and Jev ranking</h2>
          {result.candidates.map((c: Any) => (
            <div key={c.id} style={{ borderTop: "1px solid #eee", padding: "8px 0" }}>
              <b>Option {c.id}</b> · {c.weekday} {c.date} · meeting {c.meeting.start.slice(11, 16)}–{c.meeting.end.slice(11, 16)} · {c.venue.name}
              <div style={{ fontSize: 13 }}>Out {c.outbound.service} {c.outbound.depart}→{c.outbound.arrive} · Back {c.return.service} {c.return.depart}→{c.return.arrive} · door to door {c.hold.start.slice(11, 16)}–{c.hold.end.slice(11, 16)}</div>
              <ul style={{ fontSize: 12, color: "#556", margin: "4px 0 0", paddingLeft: 18 }}>{c.evidence.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
            </div>
          ))}
          {result.rank_answers && <div style={{ marginTop: 8 }}><AnswerTable answers={result.rank_answers} /></div>}
          {result.dropped?.length > 0 && <details style={{ marginTop: 8 }}><summary>Dropped ({result.dropped.length})</summary><ul style={{ fontSize: 12 }}>{result.dropped.map((d: Any, i: number) => <li key={i}>{d.date} {d.start ?? ""}: {d.reason}</li>)}</ul></details>}
        </div>
      )}

      {result?.draft_reply && (
        <div style={card}><h2 style={{ fontSize: 17, margin: "0 0 8px" }}>Draft reply (not sent)</h2><div style={{ fontSize: 13, color: "#556" }}>To: {result.draft_reply.to.join(", ")} · {result.draft_reply.subject}</div><pre style={mono}>{result.draft_reply.body}</pre></div>
      )}

      {inputs && (
        <div style={card}>
          <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>Inputs</h2>
          <details><summary>Email thread</summary><pre style={mono}>{JSON.stringify(inputs.inputs.thread, null, 2)}</pre></details>
          <details><summary>Computer history (synthetic)</summary><pre style={mono}>{JSON.stringify(inputs.inputs.history, null, 2)}</pre></details>
          <details><summary>Timetable cache (sourced)</summary><pre style={mono}>{JSON.stringify(inputs.inputs.timetable, null, 2)}</pre></details>
          <details><summary>Skill questions</summary><pre style={mono}>{JSON.stringify(inputs.inputs.skill.passes, null, 2)}</pre></details>
          <details><summary>Packaged Jev request (extract pass)</summary><pre style={mono}>{JSON.stringify(inputs.jev_input, null, 2)}</pre></details>
        </div>
      )}

      {result && <details style={card}><summary>Raw result JSON</summary><pre style={mono}>{JSON.stringify(result, null, 2)}</pre></details>}
    </main>
  );
}
