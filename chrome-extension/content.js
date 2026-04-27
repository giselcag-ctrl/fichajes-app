/**
 * content.js - SIMECAL Extractor Calendario
 * Runs at document_start in intranet.preprod.simecal.com
 *
 * Responsibilities:
 * 1. Inject a page-context script to intercept fetch/XHR API calls
 * 2. Forward captured API data to background via chrome.runtime.sendMessage
 * 3. Handle messages from background: EXTRACT_DOM, NAV_PREV, NAV_NEXT, GET_WEEK_DATE, SET_EMPLOYEE
 */

(function () {
  'use strict';

  // Note: fetch/XHR interception removed — blocked by intranet CSP.
  // All calendar data is extracted from DOM (TPC, previsto, events).

  // ── Handle messages from background ───────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    try {
      switch (msg.action) {

        // ── DOM Extraction ───────────────────────────────────────────────
        case 'EXTRACT_DOM': {
          // Esperar hasta que Vue haya renderizado el contenido de la semana
          // Señal fiable: .badges-totales existe Y los labels tienen texto
          (async () => {
            const MAX_WAIT = 10000;
            const INTERVAL = 300;
            const start = Date.now();
            while (Date.now() - start < MAX_WAIT) {
              const labels   = document.querySelectorAll('.v-calendar-daily_head-day-label');
              const hasBadge = !!document.querySelector('.badges-totales');

              if (labels.length >= 5 && hasBadge) {
                const elapsed = Date.now() - start;

                // Esperar a que el week label (barraTareas) esté listo
                const barra        = document.querySelector('.barraTareas');
                const hasWeekLabel = barra && /S\s+\d+/i.test(barra.textContent || '');

                // Esperar a que al menos un día tenga su TPC renderizado (Xh o XhYm)
                // Esto evita extraer cuando los badges aún no han cargado
                const hasHours = [...labels].some(el => /\d+h/i.test(el.textContent || ''));

                // Listo cuando: week label OK + (hay horas YA o pasaron 5s → semana sin fichajes)
                if (hasWeekLabel && (hasHours || elapsed > 5000)) break;

                // Seguridad: nunca esperar más de 9s
                if (elapsed > 9000) break;
              }

              await new Promise(r => setTimeout(r, INTERVAL));
            }
            const result = extractCalendarDOM();
            sendResponse({ ok: true, data: result });
          })();
          break;
        }

        case 'DEBUG_DOM': {
          // 1. HTML del contenedor principal (más grande)
          const mainArea =
            document.querySelector('.sheetPadre') ||
            document.querySelector('main') ||
            document.querySelector('#app') ||
            document.body;
          const html = mainArea ? mainArea.innerHTML.substring(0, 15000) : 'No encontrado';

          // 2. Todas las clases CSS únicas que existen en la página
          const allClasses = new Set();
          document.querySelectorAll('*').forEach(el => {
            (el.className || '').toString().split(/\s+/).forEach(c => {
              if (c && c.length > 2) allClasses.add(c);
            });
          });
          const classesWithDia = [...allClasses].filter(c =>
            /dia|day|col|tpc|hora|horas|semana|week|event|tarea|jornada|lun|mar|mie|jue|vie|sab|dom/i.test(c)
          ).sort();

          // 3. Elementos que contienen patrones de horas "Xh" o día "LUN MAR..."
          const horaHits = [];
          document.querySelectorAll('*').forEach(el => {
            const t = (el.textContent || '').trim();
            if (
              (/\d+h\s*\d*m?/i.test(t) || /\b(LUN|MAR|MI[EÉ]|JUE|VIE|S[AÁ]B|DOM)\b/i.test(t))
              && t.length < 150 && el.children.length < 5
            ) {
              horaHits.push({ tag: el.tagName, cls: el.className.toString().substring(0, 80), text: t.substring(0, 100) });
            }
          });

          // 4. Primer elemento con cada clase "relevante" y su estructura
          const classSamples = {};
          classesWithDia.slice(0, 20).forEach(cls => {
            const el = document.querySelector('.' + CSS.escape(cls));
            if (el) classSamples[cls] = el.innerHTML.substring(0, 300);
          });

          sendResponse({
            ok: true,
            html: html,
            classesWithDia: classesWithDia,
            horaHits: horaHits.slice(0, 40),
            classSamples: classSamples
          });
          break;
        }

        // ── Navigation: Previous week ────────────────────────────────────
        case 'NAV_PREV': {
          // Reintentar hasta 4 veces con 400ms de espera — por si Vue está en transición
          (async () => {
            for (let attempt = 0; attempt < 4; attempt++) {
              const btn = findNavButton('prev');
              if (btn) {
                btn.click();
                sendResponse({ ok: true, attempt, btnClass: btn.className.substring(0, 80) });
                return;
              }
              await new Promise(r => setTimeout(r, 400));
            }
            // Diagnóstico final si todos los intentos fallaron
            const barra2 = document.querySelector('.barraTareas');
            const allBtns2 = Array.from(document.querySelectorAll('button, [role="button"]'));
            const beforeCount = barra2
              ? allBtns2.filter(b => barra2.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING).length
              : -1;
            sendResponse({ ok: false, error: 'Prev button not found after 4 attempts', beforeCount, totalButtons: allBtns2.length, hasBarraTareas: !!barra2 });
          })();
          break;
        }

        // ── Navigation: Next week ────────────────────────────────────────
        case 'NAV_NEXT': {
          // Reintentar hasta 4 veces con 400ms de espera
          (async () => {
            for (let attempt = 0; attempt < 4; attempt++) {
              const btn = findNavButton('next');
              if (btn) {
                btn.click();
                sendResponse({ ok: true, attempt, btnClass: btn.className.substring(0, 80) });
                return;
              }
              await new Promise(r => setTimeout(r, 400));
            }
            sendResponse({ ok: false, error: 'Next button not found after 4 attempts' });
          })();
          break;
        }

        // ── Get current week start date ──────────────────────────────────
        case 'GET_WEEK_DATE': {
          const date = getWeekStartDate();
          sendResponse({ ok: true, date: date });
          break;
        }

        // ── Set employee code in input ───────────────────────────────────
        case 'SET_EMPLOYEE': {
          const ok = setEmployeeCode(msg.code);
          sendResponse({ ok: ok });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown action' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true; // keep channel open for async
  });

  // ── DOM extraction helpers ─────────────────────────────────────────────────
  // Based on Vuetify v-calendar DOM structure confirmed via debug:
  //   .v-calendar-daily_head-day       → one column header per day
  //     .v-calendar-daily_head-weekday → "lun" / "mar" / etc.
  //     .v-calendar-daily_head-day-label → "20  8h 20m    8h 5min"
  //       .datos-cabecera              → "8h 20m    8h 5min"
  //         .badge.color-lime          → TPC del día
  //         .badge.color-black         → previsto del día
  //   .badges-totales                  → resumen semanal
  //     .badge.color-lime              → TPC total semana
  //     .badge.color-black             → previsto total
  //     .badge.color-purple            → km total

  const MONTHS_ES = {
    'enero':1,'ene':1,
    'febrero':2,'feb':2,
    'marzo':3,
    'abril':4,'abr':4,
    'mayo':5,
    'junio':6,'jun':6,
    'julio':7,'jul':7,
    'agosto':8,'ago':8,
    'septiembre':9,'sep':9,'sept':9,
    'octubre':10,'oct':10,
    'noviembre':11,'nov':11,
    'diciembre':12,'dic':12
  };

  function parseBadgeText(el) {
    if (!el) return null;
    const t = el.textContent.trim();
    return t || null;
  }

  function extractCalendarDOM() {
    const result = {
      weekLabel:  '',
      tpcTotal:   null,
      previsto:   null,
      kmTotal:    null,
      weekStart:  null,
      weekEnd:    null,
      days:       []
    };

    try {
      // ── 1. Week label ("S 17 - abril 2026") from barraTareas ──────────
      const header = document.querySelector('.barraTareas');
      if (header) {
        const ht = header.textContent || '';
        const wm = ht.match(/S\s+\d+\s*[-–]\s*\w+\s+\d{4}/);
        if (wm) result.weekLabel = wm[0].trim();
      }

      // ── 2. Week totals from .badges-totales ───────────────────────────
      const bt = document.querySelector('.badges-totales');
      if (bt) {
        result.tpcTotal  = parseBadgeText(bt.querySelector('.badge.color-lime'));
        result.previsto  = parseBadgeText(bt.querySelector('.badge.color-black'));
        const kmEl = bt.querySelector('.badge.color-purple');
        if (kmEl) result.kmTotal = kmEl.textContent.trim().replace('Km','').trim();
      }

      // ── 3. Reference month + year for date construction ───────────────
      let refMonth = 0, refYear = 0;
      if (result.weekLabel) {
        const dm = result.weekLabel.toLowerCase().match(/(\w+)\s+(\d{4})/);
        if (dm && MONTHS_ES[dm[1]]) {
          refMonth = MONTHS_ES[dm[1]];
          refYear  = parseInt(dm[2]);
        }
      }

      // ── 4. Day columns ────────────────────────────────────────────────
      const dayHeads = document.querySelectorAll('.v-calendar-daily_head-day');
      const rawNums  = [];

      for (const dh of dayHeads) {
        const weekdayEl = dh.querySelector('.v-calendar-daily_head-weekday');
        const weekday   = (weekdayEl ? weekdayEl.textContent.trim() : '').toLowerCase();

        // Day number is the first digits in the label: "20  8h 20m  8h 5min"
        const labelEl   = dh.querySelector('.v-calendar-daily_head-day-label');
        const labelText = labelEl ? labelEl.textContent.trim() : '';
        const numMatch  = labelText.match(/^(\d{1,2})/);
        const dayNum    = numMatch ? parseInt(numMatch[1]) : null;

        // TPC y previsto — fuente primaria: label text "29  8h 0min    8h 0min"
        let tpc = null, previsto = null;
        const horasMatches = [...labelText.matchAll(/(\d{1,3}h(?:\s*\d{1,2}m(?:in)?)?)/g)];
        if (horasMatches[0]) tpc      = horasMatches[0][1].trim();
        if (horasMatches[1]) previsto = horasMatches[1][1].trim();

        // Fallback: .datos-cabecera badges (días con trabajo normal)
        if (!tpc) {
          const cab = dh.querySelector('.datos-cabecera');
          if (cab) {
            tpc      = parseBadgeText(cab.querySelector('.badge.color-lime'));
            previsto = parseBadgeText(cab.querySelector('.badge.color-black'));
            if (!tpc) {
              const badges = cab.querySelectorAll('.div-badge.has-tooltip');
              if (badges[0]) tpc      = badges[0].textContent.trim() || null;
              if (badges[1]) previsto = badges[1].textContent.trim() || null;
            }
          }
        }

        rawNums.push(dayNum);
        result.days.push({ weekday, dayNum, date: null, tpc, previsto, events: [] });
      }

      // ── 5. Assign ISO dates handling month rollovers ──────────────────
      // Logic: if pre-rollover day numbers exceed the days in refMonth,
      // those days belong to refMonth-1; otherwise they belong to refMonth.
      if (refMonth > 0 && rawNums.length > 0) {
        // Find first rollover (day number decreases)
        let rolloverAt = -1;
        for (let i = 1; i < rawNums.length; i++) {
          if (rawNums[i] !== null && rawNums[i-1] !== null && rawNums[i] < rawNums[i-1]) {
            rolloverAt = i;
            break;
          }
        }

        let curMonth = refMonth, curYear = refYear;

        if (rolloverAt > 0) {
          // Check if pre-rollover days exceed the capacity of refMonth
          const validPre      = rawNums.slice(0, rolloverAt).filter(n => n !== null);
          const maxPreRollover = validPre.length > 0 ? Math.max(...validPre) : 0;
          const daysInRefMonth = new Date(refYear, refMonth, 0).getDate();

          if (maxPreRollover > daysInRefMonth) {
            // Pre-rollover days belong to refMonth-1 (e.g. Jan 28-31 when weekLabel=feb)
            curMonth = refMonth - 1;
            if (curMonth === 0) { curMonth = 12; curYear--; }
          }
          // else: pre-rollover days ARE refMonth, post-rollover will be refMonth+1
        }

        let prevNum = 0;
        for (let i = 0; i < result.days.length; i++) {
          const d   = result.days[i];
          const num = rawNums[i];
          if (num === null) { prevNum = 0; continue; }
          if (prevNum > 0 && num < prevNum) {
            curMonth++;
            if (curMonth > 12) { curMonth = 1; curYear++; }
          }
          prevNum = num;
          d.date = `${curYear}-${String(curMonth).padStart(2,'0')}-${String(num).padStart(2,'0')}`;
        }
      }

      // ── 6. Events: all-day (header) + timed (body) ───────────────────
      // FESTIVO / VACACIONES / etc. are all-day events that appear as
      // .v-event chips inside the column HEADER, not in the timed body.
      const dayContainers = document.querySelectorAll('.v-calendar-daily__day');
      const dayHeaders    = document.querySelectorAll('.v-calendar-daily_head-day');

      for (let i = 0; i < result.days.length; i++) {
        const seen = new Set();
        const events = [];
        const addEv = raw => {
          const t = (raw || '').trim().replace(/\s+/g, ' ').substring(0, 150);
          if (t.length > 2 && !seen.has(t)) { seen.add(t); events.push(t); }
        };

        // A. All-day events from the day-header (FESTIVO, VACACIONES PREVISTAS…)
        const hd = dayHeaders[i];
        if (hd) {
          // v-event* elements not inside the TPC label / datos-cabecera
          hd.querySelectorAll('[class*="v-event"]').forEach(el => {
            if (!el.closest('.datos-cabecera') && !el.closest('.badges-totales') &&
                !el.closest('.v-calendar-daily_head-day-label')) {
              addEv(el.textContent);
            }
          });
          // Vuetify chips
          hd.querySelectorAll('.v-chip').forEach(el => addEv(el.textContent));
          // title / aria-label tooltip hints
          hd.querySelectorAll('[title]').forEach(el => {
            const t = el.getAttribute('title');
            if (t && t.length > 2) addEv(t);
          });
          // Classes explicitly named after day-types
          hd.querySelectorAll('[class*="festivo"],[class*="vacacion"],[class*="holiday"],[class*="ausencia"]')
            .forEach(el => addEv(el.textContent));
        }

        // B. Timed events from the body
        if (i < dayContainers.length) {
          const dc = dayContainers[i];
          dc.querySelectorAll('.v-event-draggable').forEach(el => addEv(el.textContent));
          // Fallback if no draggable events
          if (events.length === 0) {
            dc.querySelectorAll('.v-event-timed').forEach(el => addEv(el.textContent));
          }
        }

        result.days[i].events = events;
      }

      // ── 7. weekStart / weekEnd ────────────────────────────────────────
      const dated = result.days.filter(d => d.date);
      if (dated.length > 0) {
        result.weekStart = dated[0].date;
        result.weekEnd   = dated[dated.length - 1].date;
      }

    } catch (e) {
      result.error = e.message;
    }

    return result;
  }

  // ── Navigation helpers ─────────────────────────────────────────────────────

  function findNavButton(direction) {
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));

    // ── Strategy 0: orden DOM relativo a .barraTareas ────────────────────────────
    // Layout confirmado: [HOY][📅][<][>][barraTareas]
    // Ambos botones de nav están ANTES del label en el DOM.
    // Usamos compareDocumentPosition para detectar orden sin getBoundingClientRect
    // (que devuelve 0 en tabs inactivas).
    const barra = document.querySelector('.barraTareas');
    if (barra) {
      // Botones que aparecen ANTES de .barraTareas en el documento
      const before = allButtons.filter(btn =>
        barra.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_PRECEDING
      );
      if (before.length >= 2) {
        // Los últimos 2 botones antes del label son [<] y [>]
        // before[last-1] = < (prev),  before[last] = > (next)
        if (direction === 'prev') return before[before.length - 2];
        else                      return before[before.length - 1];
      }
    }

    // ── Strategy 1: texto exacto < > o símbolos ──────────────────────────────────
    const prevSymbols = ['<', '‹', '«', '←', 'prev', 'anterior'];
    const nextSymbols = ['>', '›', '»', '→', 'next', 'siguiente'];
    const symbols = direction === 'prev' ? prevSymbols : nextSymbols;

    for (const btn of allButtons) {
      const text      = btn.textContent.trim().toLowerCase();
      const title     = (btn.getAttribute('title') || '').toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      for (const sym of symbols) {
        if (text === sym || title.includes(sym) || ariaLabel.includes(sym)) return btn;
      }
    }

    // ── Strategy 2: iconos Material Design (mdi-chevron-left / mdi-chevron-right) ──
    const mdiClass = direction === 'prev' ? 'mdi-chevron-left' : 'mdi-chevron-right';
    const mdiEl = document.querySelector(`[class*="${mdiClass}"]`);
    if (mdiEl) {
      const btn = mdiEl.closest('button') || mdiEl.closest('[role="button"]');
      if (btn) return btn;
    }
    // Material Icons font (iconText = "chevron_left" / "chevron_right")
    const miText = direction === 'prev' ? 'chevron_left' : 'chevron_right';
    for (const btn of allButtons) {
      for (const icon of btn.querySelectorAll('i, .v-icon, mat-icon')) {
        if ((icon.textContent || '').trim().toLowerCase() === miText) return btn;
      }
    }

    // ── Strategy 3: posicional — dos botones pequeños cerca entre sí ─────────────
    // (sólo funciona si la pestaña está activa/visible)
    const small = allButtons.filter(btn => {
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.width < 80 && r.height > 0 && r.height < 80;
    });
    if (small.length >= 2) {
      small.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      return direction === 'prev' ? small[0] : small[small.length - 1];
    }

    return null;
  }

  function getWeekStartDate() {
    // Use the real barraTareas header: "S 17 - abril 2026"
    const header = document.querySelector('.barraTareas');
    if (header) {
      const ht = header.textContent || '';
      const wm = ht.match(/S\s+\d+\s*[-–]\s*(\w+)\s+(\d{4})/);
      if (wm && MONTHS_ES[wm[1].toLowerCase()]) {
        // Return first day of the week from the DOM (via extractCalendarDOM)
        const dom = extractCalendarDOM();
        if (dom.weekStart) return dom.weekStart;
      }
    }
    // Fallback: URL
    const urlMatch = window.location.href.match(/(\d{4}-\d{2}-\d{2})/);
    if (urlMatch) return urlMatch[1];
    return null;
  }

  function setEmployeeCode(code) {
    // Look for the employee input field — typically top-right, near label "Empleado"
    const inputSelectors = [
      'input[placeholder*="empleado" i]',
      'input[placeholder*="employee" i]',
      'input[placeholder*="código" i]',
      'input[placeholder*="codigo" i]',
      'input[ng-model*="empleado" i]',
      'input[ng-model*="codigo" i]',
      'input[class*="empleado" i]',
      'input[id*="empleado" i]',
      'input[name*="empleado" i]'
    ];

    let input = null;
    for (const sel of inputSelectors) {
      input = document.querySelector(sel);
      if (input) break;
    }

    // Fallback: look for label "Empleado" and find nearest input
    if (!input) {
      const labels = Array.from(document.querySelectorAll('label, span, p, div'))
        .filter(el => el.textContent.trim().toLowerCase().includes('empleado') && el.children.length === 0);
      for (const label of labels) {
        let sibling = label.nextElementSibling;
        while (sibling) {
          if (sibling.tagName === 'INPUT') { input = sibling; break; }
          const inp = sibling.querySelector('input');
          if (inp) { input = inp; break; }
          sibling = sibling.nextElementSibling;
        }
        if (!input) {
          const parent = label.parentElement;
          if (parent) {
            input = parent.querySelector('input');
          }
        }
        if (input) break;
      }
    }

    // Last resort: find a short text input in the top portion of the page
    if (!input) {
      const allInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      const topInputs = allInputs.filter(inp => {
        const rect = inp.getBoundingClientRect();
        return rect.top < 150 && rect.width < 200;
      });
      if (topInputs.length > 0) input = topInputs[0];
    }

    if (!input) return false;

    // Set value using native input setter to trigger Vue reactivity
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (nativeInputValueSetter && nativeInputValueSetter.set) {
      nativeInputValueSetter.set.call(input, code);
    } else {
      input.value = code;
    }

    // Dispatch events to trigger Vue reactivity (SIN Enter — evita navegación no deseada)
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));

    return true;
  }

})();
