#!/usr/bin/env node
/**
 * Daily health check for the third-party endpoints Kiesel depends on.
 *
 * Reads checks.json, probes every endpoint, and writes public/ — a status
 * page for humans plus status.json and history.json for machines.
 *
 * A check reports one of:
 *   ok       the endpoint answered and the expectation held
 *   sample   the endpoint works, but our example URL is gone (404 on a
 *            sample) — our problem to fix, not an outage
 *   blocked  the endpoint refuses datacenter traffic, so a CI runner cannot
 *            judge it. Set "datacenterBlocked" on a check to enable this.
 *            Use sparingly and only with evidence that a consumer connection
 *            gets a different answer — otherwise it hides real outages.
 *   fail     the endpoint is down or changed shape
 *
 * Separating "sample" from "fail" matters: a dead example video would
 * otherwise show up as a dead provider and train everyone to ignore the page.
 *
 * Node 20+, no dependencies.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const TIMEOUT_MS = 20000;
const HISTORY_LENGTH = 30;
const UA = "Mozilla/5.0 (compatible; KieselStatus/1.0; +https://kiesel.app)";

async function probe(url, { accept } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": UA, ...(accept ? { Accept: accept } : {}) },
    });
    const body = await res.text();
    return { status: res.status, ok: res.ok, body, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, ok: false, body: "", ms: Date.now() - started, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

function oembedUrl(check) {
  const u = new URL(check.endpoint);
  u.searchParams.set("url", check.sample);
  u.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(check.extraParams ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

async function runCheck(check) {
  const base = { id: check.id, name: check.name, note: check.note ?? null };
  const result = await runProbe(check, base);
  // A blocked-by-datacenter endpoint reports "blocked" rather than "fail":
  // from CI we genuinely cannot tell whether it is healthy.
  if (result.state === "fail" && check.datacenterBlocked) {
    return { ...result, state: "blocked",
      detail: `Von Rechenzentrums-IPs gesperrt (${result.status || "kein Status"}) — aus CI nicht prüfbar.` };
  }
  return result;
}

async function runProbe(check, base) {

  if (check.type === "oembed") {
    const url = oembedUrl(check);
    const r = await probe(url, { accept: "application/json" });
    if (r.status === 404) {
      return { ...base, state: "sample", status: r.status, ms: r.ms,
        detail: "Beispiel-URL nicht mehr verfügbar — Endpunkt selbst antwortet." };
    }
    if (!r.ok) {
      return { ...base, state: "fail", status: r.status, ms: r.ms,
        detail: r.error ?? `HTTP ${r.status}` };
    }
    try {
      const json = JSON.parse(r.body);
      const usable = json.html || json.thumbnail_url || json.title;
      return usable
        ? { ...base, state: "ok", status: r.status, ms: r.ms, detail: json.title ?? "oEmbed ok" }
        : { ...base, state: "fail", status: r.status, ms: r.ms,
            detail: "JSON ohne html/title — Antwortformat geändert." };
    } catch {
      return { ...base, state: "fail", status: r.status, ms: r.ms,
        detail: "Antwort ist kein JSON." };
    }
  }

  if (check.type === "json") {
    const r = await probe(check.url, { accept: "application/json" });
    if (!r.ok) return { ...base, state: "fail", status: r.status, ms: r.ms, detail: r.error ?? `HTTP ${r.status}` };
    try {
      const json = JSON.parse(r.body);
      return json[check.expectField] !== undefined
        ? { ...base, state: "ok", status: r.status, ms: r.ms, detail: `Feld "${check.expectField}" vorhanden` }
        : { ...base, state: "fail", status: r.status, ms: r.ms,
            detail: `Feld "${check.expectField}" fehlt — Antwortformat geändert.` };
    } catch {
      return { ...base, state: "fail", status: r.status, ms: r.ms, detail: "Antwort ist kein JSON." };
    }
  }

  if (check.type === "pattern") {
    const r = await probe(check.url);
    if (!r.ok) return { ...base, state: "fail", status: r.status, ms: r.ms, detail: r.error ?? `HTTP ${r.status}` };
    const re = new RegExp(check.pattern);
    return re.test(r.body)
      ? { ...base, state: "ok", status: r.status, ms: r.ms, detail: "Muster gefunden" }
      : { ...base, state: "fail", status: r.status, ms: r.ms,
          detail: `Muster /${check.pattern}/ nicht mehr in der Antwort.` };
  }

  const r = await probe(check.url);
  return r.ok
    ? { ...base, state: "ok", status: r.status, ms: r.ms, detail: `HTTP ${r.status}` }
    : { ...base, state: "fail", status: r.status, ms: r.ms, detail: r.error ?? `HTTP ${r.status}` };
}

const STATE_LABEL = { ok: "OK", sample: "Beispiel veraltet", blocked: "Nicht prüfbar", fail: "Ausfall" };

function renderPage(report, history) {
  const counts = { ok: 0, sample: 0, blocked: 0, fail: 0 };
  for (const g of report.groups) for (const c of g.checks) counts[c.state]++;
  const overall = counts.fail > 0 ? "fail" : counts.sample > 0 ? "sample" : "ok";
  const headline = {
    ok: "Alles erreichbar",
    sample: "Läuft, Beispiele veraltet",
    fail: `${counts.fail} Ausfall${counts.fail === 1 ? "" : "e"}`,
  }[overall];

  const spark = (id) => {
    const runs = history.filter((h) => h.states[id]).slice(-HISTORY_LENGTH);
    if (!runs.length) return "";
    return runs.map((h) => `<i class="s ${h.states[id]}" title="${h.time}: ${STATE_LABEL[h.states[id]]}"></i>`).join("");
  };

  const groups = report.groups.map((g) => `
    <section>
      <h2>${g.title}</h2>
      ${g.description ? `<p class="desc">${g.description}</p>` : ""}
      <table>
        <thead><tr><th>Dienst</th><th>Status</th><th>Details</th><th>Verlauf</th></tr></thead>
        <tbody>
        ${g.checks.map((c) => `
          <tr>
            <td><strong>${c.name}</strong>${c.note ? `<br><span class="note">${c.note}</span>` : ""}</td>
            <td><span class="badge ${c.state}">${STATE_LABEL[c.state]}</span></td>
            <td class="detail">${c.detail}<span class="ms">${c.status || "–"} · ${c.ms} ms</span></td>
            <td class="spark">${spark(c.id)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>`).join("");

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiesel · Status der Drittanbieter</title>
<style>
  :root { color-scheme: light dark;
    --bg:#f9f5f0; --fg:#3b322a; --muted:#6b5f52; --dim:#9b8b78;
    --card:#fffdfa; --border:#e7ddcf;
    --ok:#4a7c3f; --sample:#b5623c; --fail:#b3261e; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#14120f; --fg:#ece5da; --muted:#b5a893; --dim:#7d7264;
    --card:#1d1a16; --border:#2e2921;
    --ok:#7fb96a; --sample:#e08a5c; --fail:#f2705f; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1rem 4rem; background:var(--bg); color:var(--fg);
    font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; }
  header { display:flex; align-items:center; gap:1rem; margin-bottom:.25rem; }
  h1 { font-size:1.4rem; margin:0; letter-spacing:.02em; }
  .overall { font-size:1.05rem; font-weight:600; padding:.3rem .8rem; border-radius:999px;
    border:1px solid var(--border); }
  .overall.ok{color:var(--ok)} .overall.sample{color:var(--sample)} .overall.fail{color:var(--fail)}
  .stamp { color:var(--muted); font-size:.9rem; margin:0 0 2rem; }
  section { background:var(--card); border:1px solid var(--border); border-radius:12px;
    padding:1.1rem 1.2rem; margin-bottom:1.2rem; }
  h2 { font-size:1.05rem; margin:0 0 .3rem; }
  .desc { color:var(--muted); font-size:.9rem; margin:0 0 .9rem; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:.75rem; text-transform:uppercase; letter-spacing:.06em;
    color:var(--dim); font-weight:600; padding:.3rem .5rem .3rem 0; }
  td { padding:.55rem .5rem .55rem 0; border-top:1px solid var(--border); vertical-align:top; }
  .note { color:var(--muted); font-size:.82rem; }
  .badge { font-size:.82rem; font-weight:600; white-space:nowrap; }
  .badge.ok{color:var(--ok)} .badge.sample{color:var(--sample)}
  .badge.blocked{color:var(--dim)} .badge.fail{color:var(--fail)}
  .detail { color:var(--muted); font-size:.88rem; }
  .ms { display:block; color:var(--dim); font-size:.78rem; }
  .spark { white-space:nowrap; }
  .s { display:inline-block; width:5px; height:16px; margin-right:2px; border-radius:1px;
    background:var(--dim); }
  .s.ok{background:var(--ok)} .s.sample{background:var(--sample)}
  .s.blocked{background:var(--dim)} .s.fail{background:var(--fail)}
  footer { color:var(--dim); font-size:.85rem; margin-top:2rem; }
  a { color:inherit; }
  @media (max-width:560px){ .spark{display:none} th:nth-child(4),td:nth-child(4){display:none} }
</style></head>
<body><div class="wrap">
  <header><h1>Kiesel · Drittanbieter</h1><span class="overall ${overall}">${headline}</span></header>
  <p class="stamp">Zuletzt geprüft: ${report.time} · ${counts.ok} ok, ${counts.sample} veraltete Beispiele, ${counts.blocked} nicht prüfbar, ${counts.fail} Ausfälle</p>
  ${groups}
  <footer>
    Täglich automatisch geprüft. <a href="status.json">status.json</a> ·
    <a href="history.json">history.json</a><br>
    <strong>Beispiel veraltet</strong>: Der Dienst antwortet, aber die hier hinterlegte
    Beispiel-URL existiert nicht mehr — unsere Baustelle, kein Ausfall des Anbieters.<br>
    <strong>Nicht prüfbar</strong>: Der Anbieter beantwortet Anfragen aus Rechenzentren nicht,
    über einen normalen Anschluss aber schon. Aus dieser Prüfung heraus lässt sich also nicht
    sagen, ob er gesund ist — YouTubes RSS-Endpunkt ist so ein Fall.
  </footer>
</div></body></html>`;
}

const root = new URL("..", import.meta.url).pathname;
const config = JSON.parse(await readFile(root + "checks.json", "utf8"));

const groups = [];
for (const group of config.groups) {
  const checks = [];
  for (const check of group.checks) checks.push(await runCheck(check));
  groups.push({ id: group.id, title: group.title, description: group.description ?? "", checks });
}

const now = new Date();
const report = { time: now.toISOString().replace("T", " ").slice(0, 16) + " UTC", generated: now.toISOString(), groups };

const historyPath = root + "public/history.json";
let history = [];
if (existsSync(historyPath)) {
  try { history = JSON.parse(await readFile(historyPath, "utf8")); } catch { history = []; }
}
const states = {};
for (const g of groups) for (const c of g.checks) states[c.id] = c.state;
history.push({ time: report.time, states });
history = history.slice(-HISTORY_LENGTH);

await mkdir(root + "public", { recursive: true });
await writeFile(root + "public/status.json", JSON.stringify(report, null, 2));
await writeFile(historyPath, JSON.stringify(history, null, 2));
await writeFile(root + "public/index.html", renderPage(report, history));

const all = groups.flatMap((g) => g.checks);
const failed = all.filter((c) => c.state === "fail");
const stale = all.filter((c) => c.state === "sample");
const blocked = all.filter((c) => c.state === "blocked");
for (const g of groups) for (const c of g.checks) {
  console.log(`${c.state.toUpperCase().padEnd(6)} ${c.name} — ${c.detail}`);
}
console.log(`\n${failed.length} Ausfälle, ${stale.length} veraltete Beispiele, ${blocked.length} nicht prüfbar.`);
// The workflow still publishes the page on failure; the exit code only drives
// the red run marker and the notification.
process.exit(failed.length > 0 ? 1 : 0);
