"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activateGrowthSidebar = activateGrowthSidebar;
const vscode = __importStar(require("vscode"));
const recorder_1 = require("../metrics/recorder");
/**
 * Growth dashboard sidebar (`vibecheck.growth` view).
 *
 * Renders a live SVG donut chart of the three gauges (Vibing / Learning /
 * Cooking) with a dynamic header that reflects which bucket the user is
 * currently winning at. Hovering over a slice surfaces its exact
 * percentage and raw count.
 *
 * Data flow:
 *   - Provider subscribes to `onSummaryChange` and posts every fresh
 *     `VibeSummary` to the webview as `{ kind: 'summary', summary }`.
 *   - On webview ready, it asks the provider for the current snapshot.
 *   - The page renders entirely client-side via inline JS — no bundler
 *     needed, no external assets, no CSP-blocked scripts.
 */
class GrowthViewProvider {
    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = renderHtml();
        // Push the current summary immediately so the page never paints
        // empty. If we don't have one cached yet, fire a refresh.
        const cached = (0, recorder_1.getLatestSummary)();
        if (cached) {
            void view.webview.postMessage({ kind: 'summary', summary: cached });
        }
        else {
            void (0, recorder_1.refreshSummary)();
        }
        const subscription = (0, recorder_1.onSummaryChange)((s) => {
            void view.webview.postMessage({ kind: 'summary', summary: s });
        });
        // Webview can also actively request the current state (e.g. after
        // a tab restore that re-mounts the iframe).
        const msgSub = view.webview.onDidReceiveMessage((msg) => {
            if (msg?.kind === 'request-summary') {
                const latest = (0, recorder_1.getLatestSummary)();
                if (latest) {
                    void view.webview.postMessage({ kind: 'summary', summary: latest });
                }
            }
        });
        view.onDidDispose(() => {
            subscription.dispose();
            msgSub.dispose();
            if (this.view === view) {
                this.view = undefined;
            }
        });
    }
}
function activateGrowthSidebar(context) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('vibecheck.growth', new GrowthViewProvider()));
}
/**
 * Self-contained HTML page that renders the donut + heading. All SVG
 * geometry is computed in the inline script from the percentages in
 * the latest summary. No external dependencies, no module bundler —
 * keeps the webview small and fast to mount.
 *
 * Theme integration: we reference VSCode's CSS variables
 * (`--vscode-foreground`, `--vscode-charts-{red,green,blue}`, etc.) so
 * the chart automatically tracks the user's theme without us having to
 * resolve ThemeColor values from the extension host.
 */
function renderHtml() {
    // Single-template literal so the file stays readable. The `nonce`
    // pattern isn't strictly needed because we're trusting our own
    // string, but VSCode's webview CSP will reject inline <script> by
    // default — we explicitly relax it.
    // eslint-disable-next-line no-useless-escape -- backslashes intentional
    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>VibeCheck Growth</title>
<style>
  :root {
    --vibing: var(--vscode-charts-red, #f48771);
    --learning: var(--vscode-charts-green, #89d185);
    --cooking: var(--vscode-charts-blue, #75beff);
    --muted: var(--vscode-descriptionForeground, #888);
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-foreground, #ddd);
    --track: var(--vscode-input-background, rgba(255,255,255,0.06));
  }
  body {
    margin: 0;
    padding: 16px 14px 24px;
    font-family: var(--vscode-font-family, system-ui);
    color: var(--fg);
    background: transparent;
    line-height: 1.45;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.2px;
  }
  .subtitle {
    margin: 0 0 20px;
    font-size: 12px;
    color: var(--muted);
  }
  .chart-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    margin: 8px 0 18px;
  }
  svg.donut {
    width: 200px;
    height: 200px;
    overflow: visible;
  }
  svg.donut .track {
    fill: none;
    stroke: var(--track);
    stroke-width: 18;
  }
  svg.donut .slice {
    fill: none;
    stroke-width: 18;
    stroke-linecap: butt;
    transition: stroke-width 120ms ease, opacity 120ms ease;
    cursor: default;
  }
  svg.donut .slice:hover {
    stroke-width: 22;
  }
  svg.donut.dim .slice {
    opacity: 0.3;
  }
  svg.donut .slice.hovered {
    opacity: 1;
  }
  .center-label {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    pointer-events: none;
  }
  .center-pct {
    font-size: 28px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .center-name {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--muted);
    margin-top: 2px;
  }
  .legend {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
  }
  .legend-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: default;
  }
  .legend-row:hover {
    background: var(--track);
  }
  .legend-swatch {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .legend-name {
    flex: 1;
    color: var(--fg);
  }
  .legend-pct {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--fg);
  }
  .legend-row.muted .legend-name,
  .legend-row.muted .legend-pct {
    color: var(--muted);
  }
  .legend-row.muted .legend-swatch {
    opacity: 0.35;
  }
  .empty {
    text-align: center;
    color: var(--muted);
    font-size: 12px;
    margin-top: 24px;
    line-height: 1.6;
  }
</style>
</head>
<body>
<h2 id="headline">VibeCheck</h2>
<p class="subtitle" id="subtitle">Tracking AI-generated code you've engaged with.</p>

<div class="chart-wrap">
  <svg class="donut" viewBox="0 0 100 100" id="donut" aria-label="Gauge donut">
    <circle class="track" cx="50" cy="50" r="40" />
  </svg>
  <div class="center-label" id="center">
    <div class="center-pct" id="center-pct">–</div>
    <div class="center-name" id="center-name">no data yet</div>
  </div>
</div>

<div class="legend" id="legend"></div>
<div class="empty" id="empty" style="display:none">
  No AI generations detected yet.<br/>
  Trigger one with <b>Ctrl+Shift+P → VibeCheck: Simulate AI Burst</b>.
</div>

<script>
(() => {
  const vscode = acquireVsCodeApi();

  // ── Geometry constants for the donut ────────────────────────────
  // Standard SVG circle hack: stroke-dasharray = "fill gap" along the
  // circumference. We rotate each slice by the cumulative offset so
  // they sit edge-to-edge starting at 12 o'clock.
  const RADIUS = 40;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  const GAUGES = [
    { key: 'vibing',   name: 'Vibing',   icon: '😎',  cssVar: '--vibing' },
    { key: 'learning', name: 'Learning', icon: '🤓',  cssVar: '--learning' },
    { key: 'cooking',  name: 'Cooking',  icon: '🚀',  cssVar: '--cooking' },
  ];

  // ── DOM refs ────────────────────────────────────────────────────
  const donutEl   = document.getElementById('donut');
  const headline  = document.getElementById('headline');
  const subtitle  = document.getElementById('subtitle');
  const centerPct = document.getElementById('center-pct');
  const centerName= document.getElementById('center-name');
  const legendEl  = document.getElementById('legend');
  const emptyEl   = document.getElementById('empty');

  let currentSummary = null;
  let hoveredKey = null; // legend or slice currently under cursor

  function getCount(s, key) {
    if (key === 'vibing')   return s.vibing_count;
    if (key === 'learning') return s.passed;
    if (key === 'cooking')  return s.overridden;
    return 0;
  }

  function getPct(s, key) {
    if (!s) return 0;
    if (key === 'vibing')   return s.vibing_pct;
    if (key === 'learning') return s.learning_pct;
    if (key === 'cooking')  return s.cooking_pct;
    return 0;
  }

  // ── Headline picker ─────────────────────────────────────────────
  // Whichever gauge has the highest % wins the spotlight. Ties
  // broken in favor of cooking → learning → vibing (we want to
  // celebrate engagement). If everything is 0, show the cold-start
  // copy instead.
  function pickWinner(s) {
    if (!s || s.generated === 0) {
      return { key: null, headline: 'VibeCheck', subtitle:
        "Tracking AI-generated code you've engaged with." };
    }
    const ranked = [...GAUGES]
      .map(g => ({ ...g, pct: getPct(s, g.key) }))
      .sort((a, b) => {
        if (b.pct !== a.pct) return b.pct - a.pct;
        const order = { cooking: 0, learning: 1, vibing: 2 };
        return order[a.key] - order[b.key];
      });
    const top = ranked[0];
    if (top.pct === 0) {
      return { key: null, headline: 'VibeCheck',
        subtitle: 'No bucket has any hits yet.' };
    }
    if (top.key === 'cooking') {
      return {
        key: 'cooking',
        headline: 'WE ARE COOKIN! ⭐ 🚀',
        subtitle: 'You overrode the AI with your own intent and ' +
          'now own the code that landed. That\\'s the dream.'
      };
    }
    if (top.key === 'learning') {
      return {
        key: 'learning',
        headline: 'Learning 🤓',
        subtitle: 'You\\'re passing comprehension checks. ' +
          'Your understanding of AI-written code is compounding.'
      };
    }
    return {
      key: 'vibing',
      headline: 'We are vibing 😎',
      subtitle: 'Most AI generations are flowing past unread. ' +
        'Try answering a checkpoint or overriding one!'
    };
  }

  // ── Donut renderer ──────────────────────────────────────────────
  function renderDonut(s) {
    // Wipe previous slices (keep the track <circle>).
    Array.from(donutEl.querySelectorAll('.slice')).forEach(n => n.remove());

    if (!s || s.generated === 0) {
      return;
    }

    let offset = 0;
    GAUGES.forEach(g => {
      const pct = getPct(s, g.key);
      if (pct <= 0) return;
      const len = (pct / 100) * CIRCUMFERENCE;

      const slice = document.createElementNS(
        'http://www.w3.org/2000/svg', 'circle'
      );
      slice.setAttribute('class', 'slice slice-' + g.key);
      slice.setAttribute('cx', '50');
      slice.setAttribute('cy', '50');
      slice.setAttribute('r', String(RADIUS));
      slice.setAttribute('stroke', 'var(' + g.cssVar + ')');
      slice.setAttribute(
        'stroke-dasharray',
        len + ' ' + (CIRCUMFERENCE - len)
      );
      slice.setAttribute('stroke-dashoffset', String(-offset));
      // SVG circles start at 3 o'clock; rotate -90deg so 0% is 12 o'clock.
      slice.setAttribute(
        'transform',
        'rotate(-90 50 50)'
      );
      slice.dataset.key = g.key;
      slice.addEventListener('mouseenter', () => setHover(g.key));
      slice.addEventListener('mouseleave', () => setHover(null));

      // Native browser tooltip as a backup if the user has dimmed
      // hover effects.
      slice.appendChild(makeTitle(
        g.icon + ' ' + g.name + ': ' + pct + '%  (' +
        getCount(s, g.key) + ' of ' + s.generated + ')'
      ));

      donutEl.appendChild(slice);
      offset += len;
    });
  }

  function makeTitle(text) {
    const t = document.createElementNS(
      'http://www.w3.org/2000/svg', 'title'
    );
    t.textContent = text;
    return t;
  }

  // ── Legend renderer ─────────────────────────────────────────────
  function renderLegend(s) {
    legendEl.innerHTML = '';
    GAUGES.forEach(g => {
      const pct = getPct(s, g.key);
      const count = s ? getCount(s, g.key) : 0;
      const fired = count > 0;

      const row = document.createElement('div');
      row.className = 'legend-row' + (fired ? '' : ' muted');
      row.dataset.key = g.key;

      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = 'var(' + g.cssVar + ')';

      const name = document.createElement('span');
      name.className = 'legend-name';
      name.textContent = g.icon + '  ' + g.name;

      const pctEl = document.createElement('span');
      pctEl.className = 'legend-pct';
      pctEl.textContent = (s && s.generated > 0)
        ? pct + '%'
        : '–';

      row.appendChild(swatch);
      row.appendChild(name);
      row.appendChild(pctEl);
      row.title = g.icon + ' ' + g.name + ': ' +
        (s && s.generated > 0 ? pct + '%' : 'no data') +
        ' (' + count + ' of ' + (s ? s.generated : 0) + ')';

      row.addEventListener('mouseenter', () => setHover(g.key));
      row.addEventListener('mouseleave', () => setHover(null));

      legendEl.appendChild(row);
    });
  }

  // ── Hover state ─────────────────────────────────────────────────
  function setHover(key) {
    hoveredKey = key;
    // Dim non-hovered slices.
    if (key) {
      donutEl.classList.add('dim');
      donutEl.querySelectorAll('.slice').forEach(el => {
        if (el.dataset.key === key) el.classList.add('hovered');
        else el.classList.remove('hovered');
      });
    } else {
      donutEl.classList.remove('dim');
      donutEl.querySelectorAll('.slice.hovered').forEach(el =>
        el.classList.remove('hovered')
      );
    }
    updateCenter();
  }

  // ── Center label ────────────────────────────────────────────────
  // When the user is hovering a gauge → show that gauge's pct + name.
  // Otherwise → show the dominant gauge's pct + name.
  function updateCenter() {
    const s = currentSummary;
    if (!s || s.generated === 0) {
      centerPct.textContent = '–';
      centerName.textContent = 'no data yet';
      return;
    }
    const winner = pickWinner(s);
    const focusKey = hoveredKey || winner.key;
    if (!focusKey) {
      centerPct.textContent = '0%';
      centerName.textContent = 'no activity';
      return;
    }
    const meta = GAUGES.find(g => g.key === focusKey);
    const pct = getPct(s, focusKey);
    centerPct.textContent = pct + '%';
    centerPct.style.color = 'var(' + meta.cssVar + ')';
    centerName.textContent = meta.icon + ' ' + meta.name;
  }

  // ── Main render entry ───────────────────────────────────────────
  function render(s) {
    currentSummary = s;
    const winner = pickWinner(s);
    headline.textContent = winner.headline;
    subtitle.textContent = winner.subtitle;

    if (!s || s.generated === 0) {
      emptyEl.style.display = 'block';
    } else {
      emptyEl.style.display = 'none';
    }

    renderDonut(s);
    renderLegend(s);
    updateCenter();
  }

  // Initial state until first message arrives.
  render(null);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.kind === 'summary') {
      render(msg.summary);
    }
  });

  // Ask for the latest summary on (re)mount.
  vscode.postMessage({ kind: 'request-summary' });
})();
</script>
</body>
</html>`;
}
//# sourceMappingURL=sidebar.js.map