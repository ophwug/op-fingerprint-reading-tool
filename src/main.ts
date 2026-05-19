import "./styles.css";
import { completeAuthCallback, isSignedIn, setAccessToken, signOut } from "./auth";
import {
  COMMA_JWT_PORTAL_URL,
  GITHUB_REPO_URL,
  HARDCODED_FP_BRANCH_INDEX_URL,
  OPENPILOT_FINGERPRINTING_URL,
  OPENPILOT_MASTER_SOURCES,
  SUNNYLINK_URL,
  SUNNYPILOT_VEHICLE_SETTINGS_URL,
} from "./constants";
import { formatLogMonoTime } from "./format";
import { scanRouteForFingerprintDebug, type FingerprintScanResult, type Recommendation } from "./scan";

const DEMO_ROUTES = [
  {
    label: "mici / Ford Bronco Sport",
    url: "https://connect.comma.ai/5beb9b58bd12b691/0000010a--a51155e496",
  },
  {
    label: "tizi / Toyota Corolla TSS2",
    url: "https://connect.comma.ai/fde53c3c109fb4c0/000002ae--7da67a8960",
  },
] as const;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app element");

app.innerHTML = `
  <section class="tool-shell">
    <header class="masthead">
      <div>
        <p class="eyebrow">openpilot route utility</p>
        <h1>Fingerprint route debugger</h1>
      </div>
    </header>

    <form class="reader-form" id="reader-form">
      <label for="route-input">comma Connect URL or public route</label>
      <div class="input-row">
        <input id="route-input" name="route" autocomplete="off" spellcheck="false"
          placeholder="Paste Connect URL here, e.g. https://connect.comma.ai/<dongle>/<route>" />
        <button class="scan-button" type="submit">Scan route</button>
      </div>
      <p class="form-hint">Reads uploaded qlogs first, falls back to rlogs, and builds a fingerprint evidence report from CarParams, firmware, startup events, and CAN messages.</p>
      <div class="demo-row">
        <select id="demo-route-select" aria-label="Demo route">
          ${DEMO_ROUTES.map((route) => `<option value="${escapeHtml(route.url)}">${escapeHtml(route.label)}</option>`).join("")}
        </select>
        <button class="ghost-button" id="demo-button" type="button">Use demo route</button>
      </div>
    </form>

    <section class="status-panel" id="status-panel" aria-live="polite">
      <div class="progress-track"><div id="progress-bar"></div></div>
      <p id="status-text">Paste a public route to inspect fingerprint evidence.</p>
    </section>

    <section id="result-panel" class="result-panel" hidden></section>

    <section class="info-grid">
      <article>
        <h2>How to get an input route</h2>
        <ol>
          <li>Open <a href="https://connect.comma.ai/" target="_blank" rel="noreferrer">comma Connect</a> and select the drive.</li>
          <li>Open <strong>More info</strong> and turn on <strong>Public access</strong>.</li>
          <li>Copy either the browser URL or the route name. Clip start/end seconds after the route are ignored.</li>
          <li>You can turn Public access off again after reading the route.</li>
        </ol>
        <div class="jwt-option" id="auth-panel"></div>
      </article>
      <article>
        <h2>Debug paths</h2>
        <p>For stock openpilot, start with the <a href="${OPENPILOT_FINGERPRINTING_URL}" target="_blank" rel="noreferrer">fingerprinting guide</a> and nightly-dev. For SunnyPilot, use <a href="${SUNNYLINK_URL}" target="_blank" rel="noreferrer">SunnyLink</a> or the <a href="${SUNNYPILOT_VEHICLE_SETTINGS_URL}" target="_blank" rel="noreferrer">vehicle selector</a>. Use <a href="${HARDCODED_FP_BRANCH_INDEX_URL}" target="_blank" rel="noreferrer">hardcoded-fp</a> only as temporary debugging help.</p>
      </article>
    </section>

    <footer>
      Route file discovery follows comma Connect's public <a href="${OPENPILOT_MASTER_SOURCES.commaApi}" target="_blank" rel="noreferrer">route files API</a>.
      Log fields come from <a href="${OPENPILOT_MASTER_SOURCES.logSchema}" target="_blank" rel="noreferrer">openpilot log.capnp</a>
      and <a href="${OPENPILOT_MASTER_SOURCES.carSchema}" target="_blank" rel="noreferrer">opendbc car.capnp</a>.
      Source: <a href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>.
    </footer>
  </section>
`;

const form = document.querySelector<HTMLFormElement>("#reader-form")!;
const input = document.querySelector<HTMLInputElement>("#route-input")!;
const scanButton = document.querySelector<HTMLButtonElement>(".scan-button")!;
const demoSelect = document.querySelector<HTMLSelectElement>("#demo-route-select")!;
const demoButton = document.querySelector<HTMLButtonElement>("#demo-button")!;
const statusText = document.querySelector<HTMLParagraphElement>("#status-text")!;
const progressBar = document.querySelector<HTMLDivElement>("#progress-bar")!;
const resultPanel = document.querySelector<HTMLElement>("#result-panel")!;
const authPanel = document.querySelector<HTMLElement>("#auth-panel")!;

renderAuthPanel();
void completePendingAuth();

demoButton.addEventListener("click", () => {
  input.value = demoSelect.value;
  input.focus();
});

authPanel.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.closest("#sign-out-button")) {
    signOut();
    renderAuthPanel();
    statusText.textContent = "Signed out. Public route scanning still works.";
    return;
  }

  if (target.closest("#save-token-button")) {
    const tokenInput = document.querySelector<HTMLInputElement>("#token-input");
    setAccessToken(tokenInput?.value ?? null);
    renderAuthPanel();
    statusText.textContent = isSignedIn() ? "Saved JWT in this browser." : "No JWT was saved.";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  clearResult();

  try {
    const result = await scanRouteForFingerprintDebug(input.value, (progress) => {
      statusText.textContent = progress.message;
      if (progress.total && progress.current) {
        progressBar.style.width = `${Math.max(5, (progress.current / progress.total) * 100)}%`;
      } else {
        progressBar.style.width = progress.phase === "done" ? "100%" : "8%";
      }
    });
    renderResult(result);
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
    progressBar.style.width = "100%";
    progressBar.classList.add("error");
  } finally {
    setBusy(false);
  }
});

function setBusy(busy: boolean): void {
  scanButton.disabled = busy;
  demoSelect.disabled = busy;
  demoButton.disabled = busy;
  input.disabled = busy;
  progressBar.classList.toggle("error", false);
  if (busy) progressBar.style.width = "4%";
}

function clearResult(): void {
  resultPanel.hidden = true;
  resultPanel.innerHTML = "";
}

function renderAuthPanel(): void {
  if (isSignedIn()) {
    authPanel.innerHTML = `<p class="jwt-saved">JWT saved. <button class="link-button" id="sign-out-button" type="button">Remove</button></p>`;
    return;
  }

  authPanel.innerHTML = `
    <details class="token-details">
      <summary>Private route? Use a JWT</summary>
      <ol class="jwt-steps">
        <li>Open <a href="${COMMA_JWT_PORTAL_URL}" target="_blank" rel="noreferrer">jwt.comma.ai</a>.</li>
        <li>Copy the JWT.</li>
        <li>Paste it here.</li>
      </ol>
      <div class="token-row">
        <input id="token-input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste JWT here" />
        <button class="secondary" id="save-token-button" type="button">Use JWT</button>
      </div>
    </details>
  `;
}

async function completePendingAuth(): Promise<void> {
  const authParams = new URLSearchParams(window.location.search);
  if (!authParams.has("code") || !authParams.has("provider")) return;
  statusText.textContent = "Completing comma sign-in...";
  progressBar.style.width = "8%";
  const result = await completeAuthCallback();
  progressBar.style.width = "100%";
  renderAuthPanel();
  if (!result.handled) return;
  if (result.error) {
    progressBar.classList.add("error");
    statusText.textContent = result.error;
  } else {
    progressBar.classList.remove("error");
    statusText.textContent = "Signed in with comma. Paste a route and scan when ready.";
  }
}

function renderResult(result: FingerprintScanResult): void {
  const car = result.carParams;
  const recognized = Boolean(car?.carFingerprint);
  const badgeClass = recognized && result.resultType !== "incomplete" ? "ok" : "warn";
  const badgeText = result.resultType === "incomplete" ? "scan incomplete" : recognized ? "recognized" : "needs fingerprint help";

  resultPanel.hidden = false;
  resultPanel.innerHTML = `
    <div class="result-header">
      <div>
        <p class="eyebrow">fingerprint evidence</p>
        <h2>${recognized ? escapeHtml(car?.carFingerprint ?? "") : "No logged car fingerprint"}</h2>
      </div>
      <span class="badge ${badgeClass}">${badgeText}</span>
    </div>
    <dl class="result-list">
      <div><dt>Route</dt><dd><code>${escapeHtml(result.routeName)}</code></dd></div>
      <div><dt>Segments</dt><dd>${result.scannedSegments} of ${result.totalSegments} ${logFileKind(result.logSource)} segment(s) decoded</dd></div>
      <div><dt>Device</dt><dd>${escapeHtml(result.routeInfo?.deviceType ?? result.initData?.deviceType ?? "unknown")}</dd></div>
      <div><dt>openpilot</dt><dd>${renderRouteVersion(result)}</dd></div>
    </dl>
    ${result.readFailures.length > 0 ? renderReadFailures(result) : ""}
    ${renderRecommendations(result.recommendations)}
    ${renderCarParams(result)}
    ${renderEvents(result)}
    ${renderCanEvidence(result)}
  `;
}

function renderRouteVersion(result: FingerprintScanResult): string {
  const routeInfo = result.routeInfo;
  const init = result.initData;
  const version = routeInfo?.version || init?.version || "unknown";
  const branch = routeInfo?.git_branch || routeInfo?.gitBranch || init?.gitBranch || "";
  const commit = routeInfo?.git_commit || routeInfo?.gitCommit || init?.gitCommit || init?.gitSrcCommit || "";
  return [version, branch, commit ? commit.slice(0, 12) : ""].filter(Boolean).map(escapeHtml).join(" / ") || "unknown";
}

function renderRecommendations(recommendations: Recommendation[]): string {
  return `
    <section class="report-section">
      <h3>Debugging options</h3>
      <div class="recommendation-grid">
        ${recommendations
          .map(
            (recommendation) => `
              <article class="recommendation ${recommendation.kind}">
                <h4>${escapeHtml(recommendation.title)}</h4>
                <p>${escapeHtml(recommendation.body)}</p>
                ${recommendation.links.length ? `<p class="link-list">${recommendation.links.map((link) => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join(" ")}</p>` : ""}
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderCarParams(result: FingerprintScanResult): string {
  const car = result.carParams;
  if (!car) {
    return `
      <section class="report-section">
        <h3>CarParams</h3>
        <p class="muted">No CarParams message was decoded. Use the CAN evidence and startup events below for manual fingerprint debugging.</p>
      </section>
    `;
  }

  return `
    <section class="report-section">
      <h3>CarParams</h3>
      <dl class="result-list compact">
        <div><dt>Brand</dt><dd>${escapeHtml(car.brand || "unknown")}</dd></div>
        <div><dt>Fingerprint</dt><dd>${escapeHtml(car.carFingerprint || "none")}</dd></div>
        <div><dt>Fingerprint source</dt><dd>${escapeHtml(car.fingerprintSourceName)} (${car.fingerprintSource})${car.fuzzyFingerprint ? ", fuzzy" : ""}</dd></div>
        <div><dt>Mode flags</dt><dd>${renderFlagList([["dashcamOnly", car.dashcamOnly], ["passive", car.passive], ["notCar", car.notCar], ["openpilotLongitudinalControl", car.openpilotLongitudinalControl]])}</dd></div>
        <div><dt>VIN</dt><dd>${car.carVin ? `<details><summary>${escapeHtml(car.carVin.redacted)}</summary><code>${escapeHtml(car.carVin.value)}</code></details>` : "n/a"}</dd></div>
        <div><dt>Log mono time</dt><dd>${formatLogMonoTime(car.logMonoTime)}</dd></div>
        <div><dt>Source segment</dt><dd>${car.segment}</dd></div>
      </dl>
      ${renderFirmwareTable(car.carFw)}
    </section>
  `;
}

function renderFirmwareTable(carFw: NonNullable<FingerprintScanResult["carParams"]>["carFw"]): string {
  if (carFw.length === 0) return `<p class="muted section-note">No firmware entries were logged in CarParams.</p>`;
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ECU</th>
            <th>Address</th>
            <th>Bus</th>
            <th>Brand</th>
            <th>Raw fwVersion bytes</th>
            <th>Python bytes</th>
            <th>FW_VERSIONS snippet</th>
            <th>Text view</th>
          </tr>
        </thead>
        <tbody>
          ${carFw
            .map(
              (fw) => `
                <tr>
                  <td>${escapeHtml(fw.ecuName)} (${fw.ecu})</td>
                  <td>${formatAddress(fw.address)}${fw.subAddress ? ` / sub ${fw.subAddress}` : ""}${fw.responseAddress ? ` / resp ${formatAddress(fw.responseAddress)}` : ""}</td>
                  <td>${fw.bus}</td>
                  <td>${escapeHtml(fw.brand || "n/a")}</td>
                  <td><code>${escapeHtml(fw.fwVersionHex || "empty")}</code></td>
                  <td><code>${escapeHtml(fw.fwVersionPython)}</code></td>
                  <td><pre><code>${escapeHtml(fw.pythonSnippet)}</code></pre></td>
                  <td>${escapeHtml(fw.fwVersionText || "n/a")}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderEvents(result: FingerprintScanResult): string {
  const importantEvents = result.onroadEvents.filter((event) =>
    ["carUnrecognized", "dashcamMode", "startupNoCar", "startupNoControl", "canBusMissing", "canError", "vehicleSensorsInvalid"].includes(event.nameText),
  );
  const events = importantEvents.length ? importantEvents : result.onroadEvents.slice(0, 16);
  return `
    <section class="report-section">
      <h3>Startup and recognition events</h3>
      ${
        events.length
          ? `<div class="event-list">${events.map((event) => `<span class="event-chip">${escapeHtml(event.nameText)} <small>seg ${event.segment}</small></span>`).join("")}</div>`
          : `<p class="muted">No onroadEvents messages were decoded.</p>`
      }
    </section>
  `;
}

function renderCanEvidence(result: FingerprintScanResult): string {
  const rows = result.canEvidence.slice(0, 240);
  return `
    <section class="report-section">
      <h3>CAN evidence</h3>
      <p class="muted section-note">${result.canEvidence.length} unique source/address/length groups${result.canEvidence.length > rows.length ? `; showing first ${rows.length}` : ""}.</p>
      ${
        rows.length
          ? `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Bus/src</th>
                    <th>Address</th>
                    <th>Length</th>
                    <th>Count</th>
                    <th>Segments</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows
                    .map(
                      (row) => `
                        <tr>
                          <td>${row.src}</td>
                          <td>${formatAddress(row.address)}</td>
                          <td>${row.dataLength}</td>
                          <td>${row.count}</td>
                          <td>${row.firstSegment === row.lastSegment ? row.firstSegment : `${row.firstSegment}-${row.lastSegment}`}</td>
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          `
          : `<p class="muted">No CAN messages were decoded.</p>`
      }
    </section>
  `;
}

function renderReadFailures(result: FingerprintScanResult): string {
  return `
    <section class="scan-warning">
      <h3>Unreadable ${logFileKind(result.logSource)} segment(s)</h3>
      <p class="muted">These segments could not be checked, so the evidence report is incomplete.</p>
      <ul>
        ${result.readFailures.map((failure) => `<li>Segment ${failure.segment}: ${escapeHtml(failure.message)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function renderFlagList(flags: Array<[string, boolean]>): string {
  const enabled = flags.filter(([, value]) => value).map(([label]) => label);
  return enabled.length ? enabled.map(escapeHtml).join(", ") : "none";
}

function logFileKind(source: FingerprintScanResult["logSource"]): "qlog" | "rlog" {
  return source === "qlogs" ? "qlog" : "rlog";
}

function formatAddress(address: number): string {
  return `0x${address.toString(16).toUpperCase()}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}
