/**
 * background.js - SIMECAL Extractor Calendario
 * Service Worker — coordinates the full extraction process
 */

'use strict';

// ── Keepalive: evita que Chrome mate el Service Worker durante la extracción ───
// Chrome MV3 termina los SW tras ~30s de inactividad. El alarm se dispara cada
// 20s y hace un acceso a storage, lo que reinicia el temporizador de inactividad.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    chrome.storage.local.get('simecalKeepalive', () => {}); // dummy read
  }
});

function startKeepalive() {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.33 }); // cada ~20s
}
function stopKeepalive() {
  chrome.alarms.clear('keepalive');
}

// ── State ──────────────────────────────────────────────────────────────────────
const DEFAULT_STATE = {
  running: false,
  paused: false,
  employees: [],
  empIndex: 0,
  startDate: '2026-01-01',
  endDate: getTodayISO(),
  weeksTotal: 0,
  weekIndex: 0,
  data: {},              // {employeeCode: [{week, days:[{date,tpc,km,oeb,events:[]}]}]}
  tabId: null,
  appUrl: 'http://localhost:3000',
  capturedApiData: [],   // raw API responses for current employee/week
  log: [],               // last 50 log entries
  complete: false,
  error: null
};

let state = { ...DEFAULT_STATE };

// ── Utilities ──────────────────────────────────────────────────────────────────

function getTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addLog(msg) {
  const entry = `[${new Date().toTimeString().slice(0,8)}] ${msg}`;
  state.log.push(entry);
  if (state.log.length > 50) state.log.shift();
  console.log('[SIMECAL]', entry);
  broadcastState();
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: getPublicState() }).catch(() => {});
}

function getPublicState() {
  return {
    running: state.running,
    paused: state.paused,
    employees: state.employees,
    empIndex: state.empIndex,
    startDate: state.startDate,
    endDate: state.endDate,
    weeksTotal: state.weeksTotal,
    weekIndex: state.weekIndex,
    empTotal: state.employees.length,
    complete: state.complete,
    error: state.error,
    log: [...state.log],
    dataKeys: Object.keys(state.data),
    appUrl: state.appUrl,
    currentEmp: state.employees[state.empIndex] || null
  };
}

async function saveStateToStorage() {
  try {
    await chrome.storage.local.set({
      simecalState: getPublicState(),
      simecalData:  state.data          // guardar datos reales para sobrevivir restart del SW
    });
  } catch (e) { /* ignore */ }
}

/**
 * Calculate the number of weeks to navigate back from today to reach the startDate week.
 * Returns a positive integer.
 */
function weeksFromStartToEnd(startDateStr, endDateStr) {
  const start = new Date(startDateStr);
  const end   = new Date(endDateStr);
  // Align to Monday
  const startMonday = getMonday(start);
  const endMonday   = getMonday(end);
  const diffMs = endMonday - startMonday;
  return Math.max(0, Math.ceil(diffMs / (7 * 24 * 3600 * 1000)));
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addWeeks(dateStr, weeks) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

// ── Message Handling ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action || msg.type) {

        // ── From popup ─────────────────────────────────────────────────────
        case 'START_EXTRACTION': {
          if (state.running) {
            sendResponse({ ok: false, error: 'Already running' });
            return;
          }
          // Init state
          state = {
            ...DEFAULT_STATE,
            employees:  msg.employees || [],
            startDate:  msg.startDate || '2026-01-01',
            endDate:    msg.endDate   || getTodayISO(),
            appUrl:     msg.appUrl    || 'http://localhost:3000',
            running:    true,
            paused:     false,
            data:       {},
            log:        [],
            complete:   false,
            error:      null,
            capturedApiData: []
          };
          state.weeksTotal = weeksFromStartToEnd(state.startDate, state.endDate) + 1;
          startKeepalive(); // mantener SW vivo durante toda la extracción
          sendResponse({ ok: true });
          // Start async — do NOT await inside the listener
          runExtraction().catch(e => {
            state.running = false;
            state.error = e.message;
            stopKeepalive();
            addLog(`ERROR fatal: ${e.message}`);
          });
          break;
        }

        case 'PAUSE_EXTRACTION': {
          state.paused = true;
          addLog('Extracción pausada.');
          sendResponse({ ok: true });
          break;
        }

        case 'RESUME_EXTRACTION': {
          state.paused = false;
          addLog('Extracción reanudada.');
          sendResponse({ ok: true });
          break;
        }

        case 'STOP_EXTRACTION': {
          state.running = false;
          state.paused  = false;
          stopKeepalive();
          addLog('Extracción detenida por el usuario.');
          if (state.tabId) {
            try { await chrome.tabs.remove(state.tabId); } catch (e) {}
            state.tabId = null;
          }
          sendResponse({ ok: true });
          break;
        }

        case 'GET_STATE': {
          sendResponse({ ok: true, state: getPublicState() });
          break;
        }

        case 'EXPORT_DATA': {
          // Si state.data está vacío (SW reiniciado), intentar recuperar de storage
          if (!state.data || Object.keys(state.data).length === 0) {
            const stored = await chrome.storage.local.get('simecalData');
            if (stored.simecalData && Object.keys(stored.simecalData).length > 0) {
              state.data = stored.simecalData;
            }
          }
          sendResponse({ ok: true, data: state.data });
          break;
        }

        // ── From content.js ────────────────────────────────────────────────
        case 'API_DATA_CAPTURED': {
          if (state.running) {
            state.capturedApiData.push({ url: msg.url, data: msg.data, ts: Date.now() });
          }
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown action: ${msg.action || msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async
});

// ── Main Extraction Flow ────────────────────────────────────────────────────────

async function runExtraction() {
  addLog(`Iniciando extracción: ${state.employees.length} empleados, ${state.weeksTotal} semanas`);

  if (state.employees.length === 0) {
    state.running = false;
    state.error = 'No hay empleados definidos';
    addLog('ERROR: No hay empleados definidos.');
    return;
  }

  // Cerrar cualquier pestaña de simecal que haya quedado abierta de ejecuciones anteriores
  try {
    const oldTabs = await chrome.tabs.query({ url: 'https://intranet.preprod.simecal.com/*' });
    for (const t of oldTabs) {
      try { await chrome.tabs.remove(t.id); } catch (e) {}
    }
    if (oldTabs.length > 0) addLog(`Cerradas ${oldTabs.length} pestaña(s) antiguas de simecal.`);
  } catch (e) {}

  // Open the tab for the first employee
  const firstEmp = state.employees[0];
  const url = `https://intranet.preprod.simecal.com/#!/calendario/${firstEmp}/`;

  addLog(`Abriendo pestaña: ${url}`);
  const tab = await chrome.tabs.create({ url, active: false });
  state.tabId = tab.id;
  await saveStateToStorage();

  // Wait for initial page load + Vue render
  await waitForTabLoad(state.tabId);
  await sleep(3000);

  // Iterate over employees
  for (let ei = 0; ei < state.employees.length; ei++) {
    if (!state.running) break;

    state.empIndex = ei;
    const empCode = state.employees[ei];

    addLog(`=== Empleado ${ei + 1}/${state.employees.length}: ${empCode} ===`);
    state.data[empCode] = [];

    // Navigate to employee calendar — recuperar pestaña si fue cerrada
    const empUrl = `https://intranet.preprod.simecal.com/#!/calendario/${empCode}/`;
    try {
      // Verificar que la pestaña sigue viva
      if (state.tabId) await chrome.tabs.get(state.tabId);
      await navigateTab(state.tabId, empUrl);
    } catch (e) {
      addLog(`Tab cerrada, reabriendo para ${empCode}...`);
      const newTab = await chrome.tabs.create({ url: empUrl, active: false });
      state.tabId = newTab.id;
      await waitForTabLoad(state.tabId);
    }
    await sleep(2500);

    // Also set employee code in the input field (belt & suspenders)
    await execInTab(state.tabId, 'SET_EMPLOYEE', { code: empCode });
    await sleep(1500);

    // The default view shows the current week. We need to navigate back to startDate.
    const weeksBack = weeksFromStartToEnd(state.startDate, state.endDate);
    addLog(`Navegando ${weeksBack} semanas atrás hasta ${state.startDate}...`);

    for (let w = 0; w < weeksBack; w++) {
      if (!state.running) break;
      await waitIfPaused();
      let navResult = await execInTab(state.tabId, 'NAV_PREV', {});
      if (!navResult || !navResult.ok) {
        await sleep(800);
        navResult = await execInTab(state.tabId, 'NAV_PREV', {});
        if (!navResult || !navResult.ok) {
          addLog(`WARN: no se pudo navegar atrás (semana ${w + 1})`);
        }
      }
      await sleep(700);
    }

    await sleep(2000);

    // Now iterate over each week from startDate to endDate
    state.weekIndex = 0;
    for (let wi = 0; wi <= weeksFromStartToEnd(state.startDate, state.endDate); wi++) {
      if (!state.running) break;
      await waitIfPaused();

      state.weekIndex = wi;
      const expectedWeekStart = addWeeks(state.startDate, wi);
      addLog(`  Semana ${wi + 1}/${state.weeksTotal} (${expectedWeekStart}) - ${empCode}`);

      // Reset API capture buffer for this week
      state.capturedApiData = [];

      // Content script polls for Vue render (up to 8s); pequeña espera base
      await sleep(800);

      // Extract DOM data
      let domResult = null;
      try {
        const resp = await execInTab(state.tabId, 'EXTRACT_DOM', {});
        if (resp && resp.ok) domResult = resp.data;
      } catch (e) {
        addLog(`  WARN: Error extrayendo DOM: ${e.message}`);
      }

      // Get current week date
      let weekDateResp = null;
      try {
        weekDateResp = await execInTab(state.tabId, 'GET_WEEK_DATE', {});
      } catch (e) {}

      const weekEntry = {
        week: expectedWeekStart,
        weekLabel:     domResult ? domResult.weekLabel  : '',
        tpcTotal:      domResult ? domResult.tpcTotal   : null,
        previsto:      domResult ? domResult.previsto   : null,
        kmTotal:       domResult ? domResult.kmTotal    : null,
        weekStart:     domResult ? domResult.weekStart  : null,
        days:          domResult ? domResult.days       : [],
        extractedAt:   new Date().toISOString()
      };

      state.data[empCode].push(weekEntry);
      await saveStateToStorage();
      broadcastState();

      // Navigate to next week (unless last)
      if (wi < weeksFromStartToEnd(state.startDate, state.endDate)) {
        let navNext = await execInTab(state.tabId, 'NAV_NEXT', {});
        if (!navNext || !navNext.ok) {
          // Retry once after a short wait (el botón puede no estar renderizado aún)
          await sleep(1200);
          navNext = await execInTab(state.tabId, 'NAV_NEXT', {});
          if (!navNext || !navNext.ok) {
            addLog(`  WARN: no se pudo navegar adelante (semana ${wi + 1})`);
          }
        }
        await sleep(1500);
      }
    }

    addLog(`  Completado empleado ${empCode}: ${state.data[empCode].length} semanas`);
  }

  // ── Wrap up ──────────────────────────────────────────────────────────────
  state.running  = false;
  state.running  = false;
  state.complete = true;
  stopKeepalive();
  addLog('✓ Extracción completada.');

  if (state.tabId) {
    try { await chrome.tabs.remove(state.tabId); } catch (e) {}
    state.tabId = null;
  }

  await saveStateToStorage();
  broadcastState();

  // System notification
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'SIMECAL Extractor',
    message: `Extracción completada: ${state.employees.length} empleados procesados.`
  });
}

// ── Tab helpers ─────────────────────────────────────────────────────────────────

function waitForTabLoad(tabId, timeout = 20000) {
  return new Promise((resolve, reject) => {
    let done = false;

    // Timer real para garantizar que nunca se quede colgado
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(check);
      resolve(); // resolver (no rechazar) para no interrumpir la extracción
    }, timeout);

    function check(tabIdUpdated, changeInfo) {
      if (done) return;
      if (tabIdUpdated === tabId && changeInfo.status === 'complete') {
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(check);

    // Resolver inmediatamente si ya está cargada
    chrome.tabs.get(tabId, tab => {
      if (done) return;
      if (chrome.runtime.lastError) {
        done = true; clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(check);
        reject(new Error('Tab not found'));
        return;
      }
      if (tab.status === 'complete') {
        done = true; clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
    });
  });
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabLoad(tabId);
}

/**
 * Send a message to the content script in the given tab.
 * Uses chrome.tabs.sendMessage with the action payload.
 */
function execInTab(tabId, action, extra = {}) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action, ...extra }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: 'No response' });
      }
    });
  });
}

async function waitIfPaused() {
  while (state.paused && state.running) {
    await sleep(500);
  }
}

// ── Restore state on service worker restart ─────────────────────────────────────
(async () => {
  try {
    const stored = await chrome.storage.local.get('simecalState');
    if (stored.simecalState) {
      // Only restore non-running state (running jobs don't survive SW restart)
      const s = stored.simecalState;
      state.employees = s.employees || [];
      state.startDate = s.startDate || '2026-01-01';
      state.endDate   = s.endDate   || getTodayISO();
      state.appUrl    = s.appUrl    || 'http://localhost:3000';
      state.complete  = s.complete  || false;
      state.log       = s.log       || [];
    }
    // Restaurar datos extraídos (sobreviven restart del SW)
    const storedData = await chrome.storage.local.get('simecalData');
    if (storedData.simecalData) {
      state.data = storedData.simecalData;
    }
  } catch (e) { /* ignore */ }
})();
