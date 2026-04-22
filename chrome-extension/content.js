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

  // ── 1. Inject the page-context interceptor ─────────────────────────────────
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      const TARGET_HOST = 'movilidad.api.preprod.simecal.com';

      // ── Intercept fetch ──────────────────────────────────────────────────
      const _originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const result = await _originalFetch.apply(this, args);
        try {
          const url = (args[0] instanceof Request ? args[0].url : String(args[0])) || '';
          if (url.includes(TARGET_HOST)) {
            const clone = result.clone();
            clone.json().then(data => {
              window.postMessage({
                source: '__simecal_ext__',
                type: 'API_RESPONSE',
                url: url,
                data: data
              }, '*');
            }).catch(() => {
              clone.text().then(text => {
                window.postMessage({
                  source: '__simecal_ext__',
                  type: 'API_RESPONSE',
                  url: url,
                  data: text
                }, '*');
              }).catch(() => {});
            });
          }
        } catch (e) {}
        return result;
      };

      // ── Intercept XMLHttpRequest ─────────────────────────────────────────
      const _XHROpen = XMLHttpRequest.prototype.open;
      const _XHRSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__simecal_url__ = url || '';
        return _XHROpen.apply(this, [method, url, ...rest]);
      };

      XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
          try {
            if (this.__simecal_url__ && this.__simecal_url__.includes(TARGET_HOST)) {
              let data;
              try { data = JSON.parse(this.responseText); }
              catch (e) { data = this.responseText; }
              window.postMessage({
                source: '__simecal_ext__',
                type: 'API_RESPONSE',
                url: this.__simecal_url__,
                data: data
              }, '*');
            }
          } catch (e) {}
        });
        return _XHRSend.apply(this, args);
      };
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  // ── 2. Listen for postMessage from page context ────────────────────────────
  window.addEventListener('message', function (event) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== '__simecal_ext__' ||
      event.data.type !== 'API_RESPONSE'
    ) return;

    try {
      chrome.runtime.sendMessage({
        action: 'API_DATA_CAPTURED',
        url: event.data.url,
        data: event.data.data
      });
    } catch (e) {
      // Extension context may be invalidated — ignore
    }
  });

  // ── 3. Handle messages from background ────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    try {
      switch (msg.action) {

        // ── DOM Extraction ───────────────────────────────────────────────
        case 'EXTRACT_DOM': {
          const result = extractCalendarDOM();
          sendResponse({ ok: true, data: result });
          break;
        }

        // ── Navigation: Previous week ────────────────────────────────────
        case 'NAV_PREV': {
          const btn = findNavButton('prev');
          if (btn) {
            btn.click();
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'Prev button not found' });
          }
          break;
        }

        // ── Navigation: Next week ────────────────────────────────────────
        case 'NAV_NEXT': {
          const btn = findNavButton('next');
          if (btn) {
            btn.click();
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'Next button not found' });
          }
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

  function extractCalendarDOM() {
    const result = {
      weekLabel: '',
      weekStart: '',
      weekEnd: '',
      days: []
    };

    try {
      // ── Week label / date range ────────────────────────────────────────
      // Try common selectors for week range header
      const weekSelectors = [
        '.semana-label', '.week-label', '.calendar-header .dates',
        '[class*="semana"]', '[class*="week-range"]', '[class*="periodo"]',
        'h2', 'h3', '.toolbar-title', '.calendar-title'
      ];
      for (const sel of weekSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.match(/\d{1,2}[\/\-\.]\d{1,2}/)) {
          result.weekLabel = el.textContent.trim();
          break;
        }
      }

      // ── Day columns ───────────────────────────────────────────────────
      // Look for column headers like "LUN 20", "MAR 21", etc.
      const dayHeaders = findDayHeaders();

      for (const header of dayHeaders) {
        const dayData = {
          label: header.label,   // e.g. "LUN 20"
          date: header.date,     // parsed date string "2026-01-05"
          tpc: null,
          km: null,
          oeb: null,
          events: []
        };

        // ── Summary chips ─────────────────────────────────────────────
        // Each day column has summary chips: TPC, KM, OEB-P
        const col = header.element;
        if (col) {
          const colParent = getColumnContainer(col);
          if (colParent) {
            dayData.tpc = extractChipValue(colParent, ['TPC', 'tpc', 'Tiempo']);
            dayData.km  = extractChipValue(colParent, ['KM', 'km', 'Km']);
            dayData.oeb = extractChipValue(colParent, ['OEB', 'oeb', '€']);

            // ── Event blocks ──────────────────────────────────────────
            dayData.events = extractEvents(colParent);
          }
        }

        result.days.push(dayData);
      }

      // ── Try to parse week start from first day ─────────────────────
      if (result.days.length > 0 && result.days[0].date) {
        result.weekStart = result.days[0].date;
        result.weekEnd   = result.days[result.days.length - 1].date;
      }

    } catch (e) {
      result.error = e.message;
    }

    return result;
  }

  function findDayHeaders() {
    const headers = [];
    const DAY_LABELS = ['LUN','MAR','MIÉ','MIE','JUE','VIE','SÁB','SAB','DOM'];

    // Strategy 1: look for th / td / div elements with day abbreviations
    const allEls = document.querySelectorAll(
      'th, td, [class*="day-header"], [class*="dia-header"], [class*="col-header"], [class*="column-header"], .fc-day-header'
    );

    for (const el of allEls) {
      const text = el.textContent.trim().toUpperCase();
      const match = text.match(/^(LUN|MAR|MI[EÉ]|JUE|VIE|S[AÁ]B|DOM)\s*(\d{1,2})/);
      if (match) {
        headers.push({
          label: text,
          date: parseDayLabel(match[1], parseInt(match[2])),
          element: el
        });
      }
    }

    // Strategy 2: look for any element whose text matches "LUN 20" pattern
    if (headers.length === 0) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.children.length > 3) continue; // skip containers
        const text = node.textContent.trim().toUpperCase();
        const match = text.match(/^(LUN|MAR|MI[EÉ]|JUE|VIE|S[AÁ]B|DOM)\s*(\d{1,2})$/);
        if (match) {
          headers.push({
            label: text,
            date: parseDayLabel(match[1], parseInt(match[2])),
            element: node
          });
        }
      }
    }

    return headers;
  }

  function parseDayLabel(dayAbbr, dayNum) {
    // We don't know month/year from the DOM label alone.
    // Try to read the URL or a date header in the page.
    const urlMatch = window.location.href.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (urlMatch) {
      return `${urlMatch[1]}-${urlMatch[2]}-${String(dayNum).padStart(2,'0')}`;
    }
    // Fallback: return day number only — background will combine with week context
    return `day-${dayNum}`;
  }

  function getColumnContainer(headerEl) {
    // Walk up to find the column wrapper, then return it
    let el = headerEl;
    for (let i = 0; i < 5; i++) {
      if (el.parentElement) el = el.parentElement;
      // If parent has sibling columns, we're at the right level
      const siblings = Array.from(el.parentElement ? el.parentElement.children : []);
      if (siblings.length >= 5 && siblings.length <= 8) {
        // Find the column corresponding to headerEl
        const colIdx = siblings.indexOf(el);
        if (colIdx >= 0) return el;
      }
    }
    // Fallback: just return the closest ancestor with enough content
    el = headerEl;
    for (let i = 0; i < 6; i++) {
      if (el.parentElement) el = el.parentElement;
      if (el.querySelectorAll('[class*="event"], [class*="evento"], [class*="inspeccion"]').length > 0) {
        return el;
      }
    }
    return headerEl.parentElement || headerEl;
  }

  function extractChipValue(container, keywords) {
    // Look for chip/badge elements near the keywords
    const chipSelectors = [
      '[class*="chip"]', '[class*="badge"]', '[class*="resumen"]',
      '[class*="summary"]', '[class*="tag"]', 'span', 'small'
    ];

    for (const sel of chipSelectors) {
      const chips = container.querySelectorAll(sel);
      for (const chip of chips) {
        const text = chip.textContent.trim();
        for (const kw of keywords) {
          if (text.toUpperCase().includes(kw.toUpperCase())) {
            // Extract numeric value from text like "TPC: 8.5h" or "KM: 120" or "OEB-P: 45.50€"
            const numMatch = text.match(/([\d]+[.,]?[\d]*)\s*[hH€km]?/);
            if (numMatch) return numMatch[1].replace(',', '.');
          }
        }
      }
    }
    return null;
  }

  function extractEvents(container) {
    const events = [];
    const eventSelectors = [
      '[class*="event"]', '[class*="evento"]', '[class*="inspeccion"]',
      '[class*="inspection"]', '[class*="appointment"]', '.fc-event',
      '[class*="card"]', '[class*="item"]'
    ];

    for (const sel of eventSelectors) {
      const els = container.querySelectorAll(sel);
      for (const el of els) {
        const text = el.textContent.trim();
        if (!text || text.length < 3) continue;

        const event = {
          raw: text,
          location: null,
          serviceType: null,
          orderNumber: null,
          timeRange: null
        };

        // Time range: "08:00 - 10:30" or "8:00-10:30"
        const timeMatch = text.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
        if (timeMatch) {
          event.timeRange = `${timeMatch[1]}-${timeMatch[2]}`;
        }

        // Order/ESB number: typically "ESB-12345" or "OT-12345" or just numbers
        const orderMatch = text.match(/\b([A-Z]{2,4}[-_]?\d{4,8})\b/);
        if (orderMatch) {
          event.orderNumber = orderMatch[1];
        }

        // Extract sub-elements
        const spans = el.querySelectorAll('span, p, div, small');
        const subTexts = Array.from(spans).map(s => s.textContent.trim()).filter(Boolean);

        // Service type heuristics: look for known keywords
        const serviceTypes = ['REBT', 'GAS', 'AP ', 'LINEAS', 'OEB', 'GASOL', 'BT', 'AT'];
        for (const st of serviceTypes) {
          if (text.toUpperCase().includes(st)) {
            event.serviceType = st.trim();
            break;
          }
        }

        // Location: first meaningful text block that's not time/order
        for (const sub of subTexts) {
          if (sub && !sub.match(/^\d{1,2}:\d{2}/) && !sub.match(/^[A-Z]{2,4}[-_]\d+$/)) {
            if (!event.location && sub.length > 3) {
              event.location = sub;
              break;
            }
          }
        }

        if (text.length > 0) events.push(event);
      }
      if (events.length > 0) break; // stop at first selector that yields results
    }

    return events;
  }

  // ── Navigation helpers ─────────────────────────────────────────────────────

  function findNavButton(direction) {
    // Strategy 1: look for buttons with < > text
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a[class*="nav"], [class*="arrow"]'));

    const prevSymbols = ['<', '‹', '«', '←', 'prev', 'anterior', 'chevron-left', 'arrow-left'];
    const nextSymbols = ['>', '›', '»', '→', 'next', 'siguiente', 'chevron-right', 'arrow-right'];
    const symbols = direction === 'prev' ? prevSymbols : nextSymbols;

    for (const btn of allButtons) {
      const text = btn.textContent.trim().toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      const classList = btn.className.toLowerCase();

      for (const sym of symbols) {
        if (text === sym || title.includes(sym) || ariaLabel.includes(sym) || classList.includes(sym)) {
          return btn;
        }
      }
    }

    // Strategy 2: look for material icons or SVG chevrons inside buttons
    for (const btn of allButtons) {
      const icons = btn.querySelectorAll('i, svg, mat-icon, [class*="icon"]');
      for (const icon of icons) {
        const iconText = icon.textContent.trim().toLowerCase();
        const iconClass = icon.className.toLowerCase();
        const symbols2 = direction === 'prev'
          ? ['chevron_left', 'arrow_back', 'navigate_before', 'left']
          : ['chevron_right', 'arrow_forward', 'navigate_next', 'right'];
        for (const sym of symbols2) {
          if (iconText.includes(sym) || iconClass.includes(sym)) return btn;
        }
      }
    }

    // Strategy 3: positional — find two adjacent buttons near each other,
    // leftmost = prev, rightmost = next
    const navCandidates = allButtons.filter(btn => {
      const rect = btn.getBoundingClientRect();
      return rect.width > 0 && rect.width < 100 && rect.height > 0 && rect.height < 100;
    });

    if (navCandidates.length >= 2) {
      navCandidates.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      if (direction === 'prev') return navCandidates[0];
      if (direction === 'next') return navCandidates[navCandidates.length - 1];
    }

    return null;
  }

  function getWeekStartDate() {
    // Strategy 1: read from URL if it contains a date
    const urlMatch = window.location.href.match(/(\d{4}-\d{2}-\d{2})/);
    if (urlMatch) return urlMatch[1];

    // Strategy 2: read from DOM — look for date-like text in header area
    const headerEls = document.querySelectorAll(
      'h1, h2, h3, .toolbar, .calendar-header, [class*="week-header"], [class*="semana"]'
    );
    for (const el of headerEls) {
      const text = el.textContent.trim();
      // Pattern: "01/01/2026 - 07/01/2026" or "1 ene 2026"
      const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
      if (dateMatch) {
        const [_, d, m, y] = dateMatch;
        return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
    }

    // Strategy 3: find first day column date
    const dayHeaders = findDayHeaders();
    if (dayHeaders.length > 0 && dayHeaders[0].date && !dayHeaders[0].date.startsWith('day-')) {
      return dayHeaders[0].date;
    }

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

    // Dispatch events to trigger Vue/Angular watchers
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
    input.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'Enter', keyCode: 13 }));

    return true;
  }

})();
