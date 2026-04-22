/**
 * popup.js - SIMECAL Extractor Calendario
 * Handles popup UI: settings, controls, progress, export, send
 */

'use strict';

// ── DOM refs ────────────────────────────────────────────────────────────────────
const elEmployees    = document.getElementById('employees');
const elStartDate    = document.getElementById('startDate');
const elEndDate      = document.getElementById('endDate');
const elAppUrl       = document.getElementById('appUrl');
const btnStart       = document.getElementById('btnStart');
const btnPause       = document.getElementById('btnPause');
const btnStop        = document.getElementById('btnStop');
const btnExport      = document.getElementById('btnExport');
const btnSend        = document.getElementById('btnSend');
const statusBadge    = document.getElementById('statusBadge');
const progressPct    = document.getElementById('progressPct');
const progressBar    = document.getElementById('progressBar');
const progressDetail = document.getElementById('progressDetail');
const logArea        = document.getElementById('logArea');

// ── State ────────────────────────────────────────────────────────────────────────
let polling = null;
let isPaused = false;
let lastLogCount = 0;
let exportData = null;

// ── Init ─────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Set default endDate to today
  elEndDate.value = getTodayISO();

  // Restore saved settings
  await loadSettings();

  // Listen for live state updates from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_UPDATE') applyState(msg.state);
  });

  // Get current state from background (in case SW is already running)
  try {
    const resp = await sendBg({ action: 'GET_STATE' });
    if (resp && resp.ok) applyState(resp.state);
  } catch (e) { /* SW not yet alive */ }
});

// ── Settings persistence ──────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(['simecalSettings', 'simecalState']);
    if (result.simecalSettings) {
      const s = result.simecalSettings;
      if (s.employees) elEmployees.value = s.employees;
      if (s.startDate)  elStartDate.value  = s.startDate;
      if (s.endDate)    elEndDate.value    = s.endDate;
      if (s.appUrl)     elAppUrl.value     = s.appUrl;
    }
    // Restore previous export data availability
    if (result.simecalState && result.simecalState.dataKeys && result.simecalState.dataKeys.length > 0) {
      btnExport.disabled = false;
      btnSend.disabled   = false;
    }
  } catch (e) { /* ignore */ }
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({
      simecalSettings: {
        employees: elEmployees.value,
        startDate: elStartDate.value,
        endDate:   elEndDate.value,
        appUrl:    elAppUrl.value
      }
    });
  } catch (e) { /* ignore */ }
}

// Save on any change
[elEmployees, elStartDate, elEndDate, elAppUrl].forEach(el => {
  el.addEventListener('change', saveSettings);
  el.addEventListener('input',  saveSettings);
});

// ── Button handlers ───────────────────────────────────────────────────────────────

btnStart.addEventListener('click', async () => {
  const employees = parseEmployeeCodes(elEmployees.value);
  if (employees.length === 0) {
    appendLog('ERROR: Introduce al menos un código de empleado.', 'error');
    return;
  }
  if (!elStartDate.value || !elEndDate.value) {
    appendLog('ERROR: Introduce las fechas de inicio y fin.', 'error');
    return;
  }
  if (elStartDate.value >= elEndDate.value) {
    appendLog('ERROR: La fecha de inicio debe ser anterior a la de fin.', 'error');
    return;
  }

  await saveSettings();

  setUIRunning(true);
  isPaused = false;
  exportData = null;
  btnExport.disabled = true;
  btnSend.disabled   = true;
  logArea.innerHTML  = '';

  const resp = await sendBg({
    action:     'START_EXTRACTION',
    employees:  employees,
    startDate:  elStartDate.value,
    endDate:    elEndDate.value,
    appUrl:     elAppUrl.value
  });

  if (!resp || !resp.ok) {
    appendLog(`ERROR iniciando: ${resp ? resp.error : 'Sin respuesta'}`, 'error');
    setUIRunning(false);
    return;
  }

  appendLog(`Extracción iniciada con ${employees.length} empleados.`, 'success');
  startPolling();
});

btnPause.addEventListener('click', async () => {
  if (!isPaused) {
    await sendBg({ action: 'PAUSE_EXTRACTION' });
    isPaused = true;
    btnPause.textContent = '▶ REANUDAR';
    btnPause.classList.remove('btn-pause');
    btnPause.style.background = 'linear-gradient(135deg, #2f855a, #48bb78)';
    btnPause.style.color = '#fff';
  } else {
    await sendBg({ action: 'RESUME_EXTRACTION' });
    isPaused = false;
    btnPause.textContent = '⏸ PAUSAR';
    btnPause.style.background = '';
    btnPause.style.color = '';
  }
});

btnStop.addEventListener('click', async () => {
  if (!confirm('¿Detener la extracción? Se perderá el progreso actual de la semana.')) return;
  await sendBg({ action: 'STOP_EXTRACTION' });
  stopPolling();
  setUIRunning(false);
  updateStatus('idle', 'Detenido');
  appendLog('Extracción detenida.', 'warn');
});

btnExport.addEventListener('click', async () => {
  try {
    const resp = await sendBg({ action: 'EXPORT_DATA' });
    if (!resp || !resp.ok) { appendLog('ERROR exportando datos.', 'error'); return; }

    exportData = resp.data;
    const json   = JSON.stringify(exportData, null, 2);
    const blob   = new Blob([json], { type: 'application/json' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    const fname  = `simecal_calendario_${getTodayISO()}.json`;
    a.href       = url;
    a.download   = fname;
    a.click();
    URL.revokeObjectURL(url);
    appendLog(`Datos exportados: ${fname}`, 'success');
  } catch (e) {
    appendLog(`ERROR export: ${e.message}`, 'error');
  }
});

btnSend.addEventListener('click', async () => {
  const appUrl = elAppUrl.value.replace(/\/$/, '');
  if (!appUrl) {
    appendLog('ERROR: URL de fichajes-app no configurada.', 'error');
    return;
  }

  try {
    const resp = await sendBg({ action: 'EXPORT_DATA' });
    if (!resp || !resp.ok) { appendLog('ERROR obteniendo datos.', 'error'); return; }

    exportData = resp.data;
    appendLog(`Enviando datos a ${appUrl}/api/calendario-data ...`);
    btnSend.disabled = true;
    btnSend.textContent = '⏳ Enviando...';

    const fetchResp = await fetch(`${appUrl}/api/calendario-data`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ data: exportData, extractedAt: new Date().toISOString() })
    });

    if (fetchResp.ok) {
      appendLog('Datos enviados correctamente a fichajes-app.', 'success');
    } else {
      appendLog(`ERROR servidor: ${fetchResp.status} ${fetchResp.statusText}`, 'error');
    }
  } catch (e) {
    appendLog(`ERROR enviando: ${e.message}`, 'error');
  } finally {
    btnSend.disabled = false;
    btnSend.textContent = '⬆ ENVIAR A FICHAJES-APP';
  }
});

// ── Polling ───────────────────────────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  polling = setInterval(async () => {
    try {
      const resp = await sendBg({ action: 'GET_STATE' });
      if (resp && resp.ok) applyState(resp.state);
    } catch (e) { /* SW may have restarted */ }
  }, 1000);
}

function stopPolling() {
  if (polling) { clearInterval(polling); polling = null; }
}

// ── Apply state from background ───────────────────────────────────────────────────

function applyState(state) {
  if (!state) return;

  // Status badge
  if (state.complete) {
    updateStatus('done', 'Completado');
    setUIRunning(false);
    stopPolling();
    btnExport.disabled = false;
    btnSend.disabled   = false;
  } else if (state.error) {
    updateStatus('error', 'Error');
    setUIRunning(false);
    stopPolling();
    appendLog(`ERROR: ${state.error}`, 'error');
  } else if (state.running && state.paused) {
    updateStatus('paused', 'Pausado');
  } else if (state.running) {
    updateStatus('running', 'Ejecutando');
  } else {
    updateStatus('idle', 'Esperando');
  }

  // Progress
  const empTotal  = state.empTotal  || 1;
  const wkTotal   = state.weeksTotal|| 1;
  const empDone   = state.empIndex  || 0;
  const wkDone    = state.weekIndex || 0;

  // Total units = empTotal * weeksTotal
  const totalUnits = empTotal * wkTotal;
  const doneUnits  = empDone * wkTotal + wkDone;
  const pct = totalUnits > 0 ? Math.min(100, Math.round((doneUnits / totalUnits) * 100)) : 0;

  progressBar.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;

  if (state.currentEmp) {
    progressDetail.textContent =
      `Empleado ${empDone + 1}/${empTotal} (${state.currentEmp}) — Semana ${wkDone + 1}/${wkTotal}`;
  } else if (state.complete) {
    progressDetail.textContent = `✓ ${empTotal} empleados, ${wkTotal} semanas/empleado procesadas`;
  } else {
    progressDetail.textContent = '—';
  }

  // Log entries
  if (state.log && state.log.length > lastLogCount) {
    const newEntries = state.log.slice(lastLogCount);
    lastLogCount = state.log.length;
    for (const entry of newEntries) {
      appendLog(entry);
    }
  }

  // Enable export if data available
  if (state.dataKeys && state.dataKeys.length > 0) {
    btnExport.disabled = false;
    btnSend.disabled   = false;
  }

  // Sync pause button text
  if (state.paused && !state.complete) {
    isPaused = true;
    btnPause.textContent = '▶ REANUDAR';
  } else if (!state.paused) {
    isPaused = false;
    btnPause.textContent = '⏸ PAUSAR';
    btnPause.style.background = '';
    btnPause.style.color = '';
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────────

function setUIRunning(running) {
  btnStart.disabled = running;
  btnPause.disabled = !running;
  btnStop.disabled  = !running;
  if (!running) {
    btnPause.textContent = '⏸ PAUSAR';
    btnPause.style.background = '';
    btnPause.style.color = '';
  }
}

function updateStatus(type, text) {
  statusBadge.textContent = text;
  statusBadge.className = `status-badge status-${type}`;
}

function appendLog(msg, cls = '') {
  const line = document.createElement('div');
  line.className = `log-entry ${cls}`;
  line.textContent = msg;
  logArea.appendChild(line);
  // Keep only last 10 visible, scroll to bottom
  while (logArea.children.length > 10) logArea.removeChild(logArea.firstChild);
  logArea.scrollTop = logArea.scrollHeight;
}

// ── Utils ─────────────────────────────────────────────────────────────────────────

function parseEmployeeCodes(raw) {
  return raw
    .split(/[\n,;]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

function getTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}
