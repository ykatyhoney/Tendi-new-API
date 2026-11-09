/** The status page. It renders from GET <base>/api/summary and refreshes itself. */
export function statusPage(basePath: string): string {
  const base = JSON.stringify(basePath)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="darkreader-lock">
<meta name="robots" content="noindex, nofollow">
<title>Tendi Family API Status</title>
<style>
  :root { color-scheme: light only; --text: #1f2328; --muted: #656d76; --line: #e5e7eb; --bg: #ffffff; --soft: #f6f8fa;
          --green: #16a34a; --green-bar: #22c55e; --amber: #d97706; --amber-bar: #f59e0b; --red: #dc2626; --red-bar: #ef4444; --none: #e5e7eb; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 920px; margin: 0 auto; padding: 32px 16px 64px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 28px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  h1 span { color: var(--muted); font-weight: 400; }
  nav { display: flex; gap: 10px; align-items: center; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { font: inherit; font-size: 14px; padding: 6px 14px; border-radius: 6px; border: 1px solid #d0d7de; background: var(--soft); color: var(--text); cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .banner { border-radius: 8px; padding: 18px 20px; color: #fff; margin-bottom: 8px; font-size: 18px; font-weight: 600; }
  .banner.operational { background: var(--green); } .banner.degraded { background: var(--amber); }
  .banner.partial { background: #ea580c; } .banner.major { background: var(--red); } .banner.unknown { background: #6b7280; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  .note { background: #fff8c5; border: 1px solid #eac54f; border-radius: 6px; padding: 10px 14px; margin-bottom: 20px; font-size: 14px; }
  section.group { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
  section.group h2 { font-size: 15px; margin: 0; padding: 12px 18px; background: var(--soft); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
  .check { padding: 14px 18px; border-bottom: 1px solid var(--line); }
  .check:last-child { border-bottom: 0; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .route { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted); margin-left: 6px; }
  .kind { font-size: 11px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; color: var(--muted); margin-left: 6px; white-space: nowrap; }
  .state { font-size: 14px; font-weight: 600; white-space: nowrap; }
  .state.operational { color: var(--green); } .state.degraded { color: var(--amber); } .state.down { color: var(--red); } .state.unknown { color: var(--muted); }
  .ms { color: var(--muted); font-weight: 400; margin-left: 6px; }
  .bars { display: flex; gap: 2px; height: 32px; margin: 10px 0 4px; }
  .bars i { flex: 1 1 0; min-width: 2px; border-radius: 2px; background: var(--none); }
  .bars i.ok { background: var(--green-bar); } .bars i.warn { background: var(--amber-bar); } .bars i.bad { background: var(--red-bar); }
  .bars i:hover { opacity: .7; }
  .scale { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }
  .error { color: var(--red); font-size: 13px; margin-top: 6px; word-break: break-word; }
  details { font-size: 13px; color: var(--muted); margin-top: 4px; }
  details summary { cursor: pointer; }
  h2.section { font-size: 17px; margin: 36px 0 12px; }
  .incident { border-left: 3px solid var(--red); padding: 8px 14px; margin-bottom: 10px; background: var(--soft); border-radius: 0 6px 6px 0; font-size: 14px; }
  .incident.resolved { border-left-color: var(--green-bar); }
  .incident small { color: var(--muted); display: block; }
  footer { color: var(--muted); font-size: 13px; margin-top: 36px; border-top: 1px solid var(--line); padding-top: 16px; }
  footer dt { font-weight: 600; color: var(--text); } footer dd { margin: 0 0 8px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Tendi Family API <span>Status</span></h1>
    <nav><a href="/docs/">API docs</a><button id="run">Run checks now</button></nav>
  </header>
  <div id="banner" class="banner unknown">Loading…</div>
  <div id="meta" class="meta"></div>
  <div id="setup"></div>
  <div id="groups"></div>
  <h2 class="section">Incidents</h2>
  <div id="incidents"></div>
  <footer>
    <dl>
      <dt>What is checked</dt>
      <dd>Every endpoint is called on each run, and no check changes data.</dd>
      <dt>read</dt><dd>A real GET.</dd>
      <dt>no-op write</dt><dd>The save resends the current values of a dedicated "Status check" household. It runs the whole write path (transaction, locks, mirror, response) and must report that nothing changed.</dd>
      <dt>expected error</dt><dd>Where a real call would create or link something, the check sends a request whose correct answer is a known error (for example a duplicate code, or a child that belongs to another family).</dd>
      <dt>Degraded</dt><dd>The check passed but took longer than <span id="slow"></span> ms. Bars are UTC days.</dd>
    </dl>
  </footer>
</main>
<script>
const BASE = ${base};
const LABEL = { operational: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'No data' };
const BANNER = { operational: 'All systems operational', degraded: 'Degraded performance', partial: 'Partial outage', major: 'Major outage', unknown: 'No checks yet' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (iso) => iso ? new Date(iso).toLocaleString() : '—';
const pct = (value) => value === null ? 'no data' : (value === 100 ? '100' : value.toFixed(2)) + '% uptime';

function bar(day) {
  let cls = '';
  if (day.uptime !== null) cls = day.uptime === 100 ? (day.slow > 0 ? 'warn' : 'ok') : day.uptime >= 95 ? 'warn' : 'bad';
  const tip = day.uptime === null ? day.date + ': no data'
    : day.date + ': ' + day.uptime.toFixed(2) + '% (' + day.total + ' checks, ' + day.fail + ' failed, ' + day.slow + ' slow, avg ' + day.avgMs + ' ms)';
  return '<i class="' + cls + '" title="' + esc(tip) + '"></i>';
}

function render(data) {
  document.getElementById('banner').className = 'banner ' + data.overall;
  document.getElementById('banner').textContent = BANNER[data.overall];
  const next = data.running ? 'running now' : data.nextRunAt ? 'next run ' + new Date(data.nextRunAt).toLocaleTimeString() : '';
  document.getElementById('meta').textContent = 'Last checked ' + time(data.lastRunAt) + ' · ' + next + ' · every ' + data.intervalSeconds + ' s';
  document.getElementById('slow').textContent = data.slowMs;
  document.getElementById('setup').innerHTML = data.setupError ? '<div class="note">The checker could not prepare its test data: ' + esc(data.setupError) + '</div>' : '';
  document.getElementById('run').disabled = data.running;
  document.getElementById('groups').innerHTML = data.groups.map((group) => {
    const down = group.checks.filter((check) => check.state === 'down').length;
    return '<section class="group"><h2><span>' + esc(group.name) + '</span><span class="state ' + (down ? 'down' : 'operational') + '">'
      + (down ? down + ' down' : group.checks.length + ' passing') + '</span></h2>'
      + group.checks.map((check) => {
        const last = check.last;
        return '<div class="check"><div class="row"><div><span class="name">' + esc(check.name) + '</span>'
          + '<span class="route">' + esc(check.method + ' ' + check.route) + '</span><span class="kind">' + esc(check.kind) + '</span></div>'
          + '<div class="state ' + check.state + '">' + LABEL[check.state] + (last ? '<span class="ms">' + last.ms + ' ms</span>' : '') + '</div></div>'
          + '<div class="bars">' + check.days.map(bar).join('') + '</div>'
          + '<div class="scale"><span>90 days ago</span><span>' + pct(check.uptime) + '</span><span>Today</span></div>'
          + (last && !last.ok ? '<div class="error">' + esc(last.error) + '</div>' : '')
          + '<details><summary>Details</summary>' + esc(check.note) + '<br>Target: ' + esc(check.target)
          + (last ? '<br>Last run ' + time(last.at) + ': HTTP ' + esc(last.status ?? 'no response') + ', ' + last.ms + ' ms' : '') + '</details>'
          + '</div>';
      }).join('') + '</section>';
  }).join('');
  document.getElementById('incidents').innerHTML = data.incidents.length === 0
    ? '<p class="meta">No incidents recorded.</p>'
    : data.incidents.map((incident) => '<div class="incident ' + (incident.endedAt ? 'resolved' : '') + '"><strong>' + esc(incident.name) + '</strong> '
      + (incident.endedAt ? 'resolved' : '<span class="state down">ongoing</span>')
      + '<small>' + time(incident.startedAt) + ' → ' + (incident.endedAt ? time(incident.endedAt) : 'now') + ' · ' + incident.failures + ' failed check' + (incident.failures === 1 ? '' : 's') + '</small>'
      + '<small>First error: ' + esc(incident.firstError) + (incident.lastError !== incident.firstError ? '<br>Last error: ' + esc(incident.lastError) : '') + '</small></div>').join('');
}

async function refresh() {
  try {
    const response = await fetch(BASE + '/api/summary', { cache: 'no-store' });
    if (response.ok) render(await response.json());
  } catch (error) {
    document.getElementById('meta').textContent = 'The status service did not answer: ' + error;
  }
}

document.getElementById('run').addEventListener('click', async () => {
  document.getElementById('run').disabled = true;
  await fetch(BASE + '/api/run', { method: 'POST' });
  await refresh();
});

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>
`
}
