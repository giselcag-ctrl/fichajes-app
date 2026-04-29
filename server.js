require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS – permite peticiones desde extensiones Chrome y la web ───────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── MongoDB ───────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://simecal:Simecal2026!@cgs-free.qu2mzke.mongodb.net/simecal?appName=CGS-Free';
let db = null;
MongoClient.connect(MONGO_URI)
  .then(client => {
    db = client.db('simecal');
    console.log('✓ MongoDB conectado');
  })
  .catch(err => console.error('✗ MongoDB error:', err.message));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB

// ─── Firma corporativa ─────────────────────────────────────────────────────
const FIRMA = `

Atenta a cualquier inquietud,

Gracias.

Carolina González Serrano
Delegado Comercial – SIMECAL
📧 cgs@simecal.com | 📞 604 56 16 20 | 📲 WhatsApp: 673 42 68 34
Cobertura Nacional – Oficinas e Inspectores en todo el territorio
<< Detectamos riesgos para evitar accidentes >>`;

// ─── Configuración SMTP ────────────────────────────────────────────────────
let smtpConfig = {
  host:  process.env.SMTP_HOST || 'smtp-mail.outlook.com',
  port:  parseInt(process.env.SMTP_PORT || '587'),
  user:  process.env.SMTP_USER || 'cgs@simecal.com',
  pass:  process.env.SMTP_PASS || ''
};

function makeTransporter() {
  return nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.port === 465,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
    tls: { rejectUnauthorized: false },
    auth: { user: smtpConfig.user, pass: smtpConfig.pass }
  });
}
let transporter = makeTransporter();

// ─── Rate limiter simple (sin dependencias extra) ─────────────────────────
const _rlStore = new Map();
function rateLimit(ip, max = 20, windowMs = 60_000) {
  const now = Date.now();
  let e = _rlStore.get(ip) || { c: 0, r: now + windowMs };
  if (now > e.r) { e.c = 0; e.r = now + windowMs; }
  e.c++;
  _rlStore.set(ip, e);
  return e.c > max; // true → bloqueado
}
// Limpiar entradas expiradas cada 5 min
setInterval(() => { const now = Date.now(); for (const [k,v] of _rlStore) if (now > v.r) _rlStore.delete(k); }, 300_000);

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Trust proxy (Render usa reverse proxy)
app.set('trust proxy', 1);

// ─── Ruta principal ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Endpoint: procesar Excel de fichajes ─────────────────────────────────
app.post('/parse-fichajes', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No se recibió archivo' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const allNames = wb.SheetNames;

    // Buscar hoja Resumen Diario
    const dsName = allNames.find(n => /diario/i.test(n))
      || allNames.find(n => /resumen/i.test(n) && !/empleado/i.test(n))
      || allNames[1] || allNames[0];

    if (!dsName || !wb.Sheets[dsName])
      return res.status(400).json({ ok: false, error: 'No se encontró hoja "Resumen Diario". Hojas: ' + allNames.join(', ') });

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[dsName], { header: 1, defval: '' });
    const days = {};
    let cd = null;

    const MESES = {
      JANUARY:'01',FEBRUARY:'02',MARCH:'03',APRIL:'04',MAY:'05',JUNE:'06',
      JULY:'07',AUGUST:'08',SEPTEMBER:'09',OCTOBER:'10',NOVEMBER:'11',DECEMBER:'12',
      ENERO:'01',FEBRERO:'02',MARZO:'03',ABRIL:'04',MAYO:'05',JUNIO:'06',
      JULIO:'07',AGOSTO:'08',SEPTIEMBRE:'09',OCTUBRE:'10',NOVIEMBRE:'11',DICIEMBRE:'12'
    };

    function pad(n) { return String(n).padStart(2, '0'); }

    function excelDateToStr(v) {
      if (typeof v === 'string' && v.includes('/')) return v.trim();
      if (typeof v === 'number') {
        const d = XLSX.SSF.parse_date_code(v);
        return pad(d.d) + '/' + pad(d.m) + '/' + d.y;
      }
      return String(v).trim();
    }

    function parseHeaderDate(s) {
      const m1 = s.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (m1) return m1[1];
      const m2 = s.match(/(\d+)\s+DE\s+(\w+)\s+DE\s+(\d{4})/i);
      if (m2) return pad(m2[1]) + '/' + (MESES[m2[2].toUpperCase()] || '01') + '/' + m2[3];
      return null;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.length) continue;
      const c0 = String(row[0] || '').trim();
      if (!c0) continue;

      // Fila separadora de día
      if (c0.includes('📅') || /\d+\s+DE\s+\w+\s+DE\s+\d{4}/i.test(c0)) {
        const fecha = row[1] ? excelDateToStr(row[1]) : parseHeaderDate(c0);
        if (fecha) { cd = fecha; if (!days[cd]) days[cd] = []; }
        continue;
      }

      if (!cd) continue;
      if (c0 === 'Empleado' || /informe|resumen|fichaje/i.test(c0)) continue;
      if (!/^[A-Za-z0-9]/.test(c0)) continue;

      const entrada = String(row[2] || '').trim();
      const salida  = String(row[3] || '').trim();
      if (!entrada || !salida) continue;

      days[cd].push({
        emp: c0,
        fecha: row[1] ? excelDateToStr(row[1]) : cd,
        entrada,
        salida,
        horas: parseFloat(String(row[4] || '0').replace(',', '.')) || 0,
        previsto: parseFloat(String(row[5] || '8').replace(',', '.')) || 8,
        incidencia: String(row[6] || '').trim()
      });
    }

    // Buscar hoja Resumen por Empleado
    const wsName = allNames.find(n => /empleado/i.test(n)) || allNames.find(n => /semanal/i.test(n)) || allNames[2];
    let weeklyData = {}, weeks = [];

    if (wsName && wb.Sheets[wsName]) {
      const wr = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { header: 1, defval: '' });
      let wl = '';
      for (let i = 0; i < wr.length; i++) {
        const row = wr[i];
        if (!row || !row.length) continue;
        const c0 = String(row[0] || '').trim();
        if (!c0) continue;
        if (/resumen|semana/i.test(c0)) { wl = c0; if (!weeklyData[wl]) weeklyData[wl] = []; continue; }
        if (c0 === 'Empleado' || !wl || !/^[A-Za-z0-9]/.test(c0)) continue;
        weeklyData[wl].push({
          emp: c0,
          diasTrabajados: parseInt(String(row[1] || '0')) || 0,
          totalHoras: parseFloat(String(row[2] || '0').replace(',', '.')) || 0,
          mediaHoras: parseFloat(String(row[3] || '0').replace(',', '.')) || 0,
          incidencias: String(row[4] || '—').trim(),
          enCentro: String(row[5] || '').trim(),
          diasIncidencias: []
        });
      }
      weeks = Object.keys(weeklyData);
    }

    res.json({ ok: true, fileName: req.file.originalname, days, weeklyData, weeks });

  } catch (err) {
    console.error('Error parseando fichajes:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Endpoint: obtener config SMTP (sin contraseña) ───────────────────────
app.get('/smtp-config', (req, res) => {
  res.json({
    host: smtpConfig.host,
    port: smtpConfig.port,
    user: smtpConfig.user,
    hasPass: !!smtpConfig.pass
  });
});

// ─── Endpoint: guardar config SMTP ────────────────────────────────────────
app.post('/smtp-config', (req, res) => {
  const { host, port, user, pass } = req.body;
  if (!host || !port || !user || !pass)
    return res.status(400).json({ ok: false, error: 'Faltan campos: host, port, user, pass' });

  smtpConfig = { host, port: parseInt(port), user, pass };
  transporter = makeTransporter();

  // Persistir en .env
  const envPath = path.join(__dirname, '.env');
  const lines = [
    `SMTP_HOST=${host}`,
    `SMTP_PORT=${port}`,
    `SMTP_USER=${user}`,
    `SMTP_PASS=${pass}`
  ].join('\n') + '\n';
  try { fs.writeFileSync(envPath, lines); } catch (e) { /* no fatal */ }

  res.json({ ok: true });
});

// ─── Endpoint: probar conexión SMTP ───────────────────────────────────────
app.get('/test-smtp', async (req, res) => {
  if (!smtpConfig.pass)
    return res.status(400).json({ ok: false, error: 'Contraseña SMTP no configurada' });
  try {
    await transporter.verify();
    res.json({ ok: true, message: 'Conexión SMTP correcta' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Endpoint: enviar un correo ────────────────────────────────────────────
app.post('/send-email', async (req, res) => {
  if (rateLimit(req.ip, 20, 60_000))
    return res.status(429).json({ ok: false, error: 'Demasiadas solicitudes. Espera un minuto.' });
  const { to, subject, body } = req.body;
  if (!to || !subject || !body)
    return res.status(400).json({ ok: false, error: 'Faltan campos: to, subject, body' });
  try {
    const info = await transporter.sendMail({
      from: '"Carolina González – SIMECAL" <cgs@simecal.com>',
      to, subject, text: body + FIRMA
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    console.error('Error al enviar correo:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Endpoint: enviar todos los correos del día ────────────────────────────
app.post('/send-all-emails', async (req, res) => {
  if (rateLimit(req.ip, 5, 300_000)) // máx 5 envíos masivos cada 5 min
    return res.status(429).json({ ok: false, error: 'Demasiadas solicitudes. Espera 5 minutos.' });
  const { emails } = req.body;
  if (!Array.isArray(emails) || emails.length === 0)
    return res.status(400).json({ ok: false, error: 'Se esperaba un array "emails"' });
  const results = [];
  for (const mail of emails) {
    try {
      const info = await transporter.sendMail({
        from: '"Carolina González – SIMECAL" <cgs@simecal.com>',
        to: mail.to, subject: mail.subject, text: mail.body + FIRMA
      });
      results.push({ to: mail.to, ok: true, messageId: info.messageId });
    } catch (err) {
      results.push({ to: mail.to, ok: false, error: err.message });
    }
  }
  const failed = results.filter(r => !r.ok);
  res.json({ ok: failed.length === 0, results, failed: failed.length });
});

// ─── API MongoDB: Directorio empleados ────────────────────────────────────
app.get('/api/directorio', async (req, res) => {
  if (!db) return res.json({ ok: false, error: 'BD no conectada' });
  try {
    const doc = await db.collection('config').findOne({ _id: 'directorio' });
    res.json({ ok: true, empleados: doc?.empleados || {} });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/directorio', async (req, res) => {
  if (!db) return res.json({ ok: false, error: 'BD no conectada' });
  try {
    const { empleados } = req.body;
    await db.collection('config').updateOne(
      { _id: 'directorio' },
      { $set: { empleados, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── API MongoDB: Historial de envíos ─────────────────────────────────────
app.post('/api/historial-envio', async (req, res) => {
  if (!db) return res.json({ ok: false, error: 'BD no conectada' });
  try {
    const { tipo, destinatario, asunto, fecha, ok } = req.body;
    await db.collection('historial_envios').insertOne({
      tipo, destinatario, asunto, fecha: fecha || new Date(), ok,
      createdAt: new Date()
    });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/historial-envio', async (req, res) => {
  if (!db) return res.json({ ok: false, error: 'BD no conectada' });
  try {
    const registros = await db.collection('historial_envios')
      .find({}).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({ ok: true, registros });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── API MongoDB: estado de conexión ──────────────────────────────────────
app.get('/api/db-status', (req, res) => {
  res.json({ ok: !!db, connected: !!db });
});

// ─── Calendario – recibir datos de la extensión Chrome ────────────────────
// POST /api/calendario-data  { data: { SGG: [...], CGS: [...] }, extractedAt }
app.post('/api/calendario-data', async (req, res) => {
  try {
    const { data, extractedAt } = req.body;
    if (!data || typeof data !== 'object')
      return res.status(400).json({ ok: false, error: 'Payload inválido: falta data' });

    const empleados = Object.keys(data);
    if (empleados.length === 0)
      return res.status(400).json({ ok: false, error: 'No hay empleados en data' });

    const ts = extractedAt || new Date().toISOString();

    if (db) {
      const col = db.collection('calendario_datos');
      // Upsert por empleado: reemplaza el documento anterior del mismo empleado
      const ops = empleados.map(emp => ({
        updateOne: {
          filter: { empleado: emp },
          update: {
            $set: {
              empleado:    emp,
              semanas:     data[emp],
              extractedAt: ts,
              updatedAt:   new Date()
            }
          },
          upsert: true
        }
      }));
      await col.bulkWrite(ops);
    }

    res.json({ ok: true, empleados, total: empleados.length, extractedAt: ts });
  } catch (e) {
    console.error('/api/calendario-data error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/calendario-data           → lista todos los empleados guardados
// GET /api/calendario-data/:empleado → datos de un empleado concreto
app.get('/api/calendario-data', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'DB no disponible' });
    const docs = await db.collection('calendario_datos')
      .find({}, { projection: { empleado: 1, extractedAt: 1, updatedAt: 1, _id: 0 } })
      .toArray();
    res.json({ ok: true, empleados: docs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/calendario-data/:empleado', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'DB no disponible' });
    const doc = await db.collection('calendario_datos')
      .findOne({ empleado: req.params.empleado.toUpperCase() });
    if (!doc) return res.status(404).json({ ok: false, error: 'Empleado no encontrado' });
    res.json({ ok: true, empleado: doc.empleado, semanas: doc.semanas, extractedAt: doc.extractedAt });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Análisis local (sin IA) ────────────────────────────────────────────────
function fmtHServer(h) {
  if (h === null || h === undefined) return '—';
  const abs = Math.abs(h);
  const hh  = Math.floor(abs);
  const mm  = Math.round((abs - hh) * 60);
  return (h < 0 ? '-' : '') + (hh > 0 ? hh + 'h ' : '') + (mm > 0 ? mm + 'min' : '') + (hh === 0 && mm === 0 ? '0h' : '');
}

function computeLocalAnalysis(empleado, semanas, totalFichaje_h, totalTareas_h, totalDiferencia_h) {
  let diasLaborables = 0, diasCumplen = 0, diasJustif = 0, diasSinDatos = 0;
  const alertas = [];
  const semanasResult = [];

  semanas.forEach(s => {
    const diasProblema = [];
    let semCumple = true;
    let semDiasLab = 0, semDiasCumple = 0;

    (s.dias || []).forEach(d => {
      if (d.esFinSemana) return;
      if (d.justificado) { diasJustif++; return; }
      if (d.sinDatos)    { diasSinDatos++; return; }
      if (d.fichaje_h === null) return;

      diasLaborables++;
      semDiasLab++;

      if (d.fichaje_h >= 7.5) {
        diasCumplen++;
        semDiasCumple++;
      } else {
        semCumple = false;
        const faltanMin = Math.round((7.5 - d.fichaje_h) * 60);
        diasProblema.push(`${d.dia} ${d.fecha}: ${fmtHServer(d.fichaje_h)} (faltan ${faltanMin}min)`);
        if (d.fichaje_h < 6) {
          alertas.push(`${d.fecha} (${d.dia?.toUpperCase()}): solo ${fmtHServer(d.fichaje_h)} fichados`);
        }
      }
    });

    semanasResult.push({
      semana:          s.semana,
      etiqueta:        s.etiqueta,
      tpcTotal:        s.tpcTotal,
      semFichaje_h:    s.semFichaje_h,
      semTareas_h:     s.semTareas_h,
      semDiferencia_h: s.semDiferencia_h,
      cumple:          semCumple,
      diasProblema,
      nota: semDiasLab > 0 ? `${semDiasCumple}/${semDiasLab} días OK` : ''
    });
  });

  const cumplimientoGlobal = diasLaborables > 0
    ? Math.round((diasCumplen / diasLaborables) * 100) : 100;

  const resumenGeneral =
    `${empleado} — Cumplimiento ${cumplimientoGlobal}%: ${diasCumplen} de ${diasLaborables} días laborables con ≥7.5h fichadas. ` +
    `${diasJustif} días justificados (festivos/vacaciones/enfermedad).` +
    (diasSinDatos > 0 ? ` ${diasSinDatos} días sin datos de fichaje.` : '') +
    (totalDiferencia_h !== null ? ` Diferencia total fichaje−tareas: ${fmtHServer(totalDiferencia_h)}.` : '');

  const recomendacion = cumplimientoGlobal >= 90
    ? `Buen cumplimiento horario. Continuar seguimiento habitual.`
    : cumplimientoGlobal >= 70
    ? `Se detectan incidencias en algunos días. Revisar los días marcados y solicitar justificación si corresponde.`
    : `Patrón de incumplimiento significativo (${100 - cumplimientoGlobal}% de días con menos de 7.5h). Se recomienda revisión con el empleado.`;

  return {
    empleado,
    resumenGeneral,
    cumplimientoGlobal,
    totalFichaje_h,
    totalTareas_h,
    totalDiferencia_h,
    alertas: alertas.slice(0, 30),
    semanas: semanasResult,
    recomendacion,
    modoLocal: true
  };
}

// ── Helpers para análisis horario ─────────────────────────────────────────

/** "8h 30min" → 8.5,  "8h" → 8,  null → null */
function parseTpcHours(str) {
  if (!str) return null;
  const m = str.match(/(\d+)h\s*(\d*)/i);
  if (!m) return null;
  return parseInt(m[1]) + (m[2] ? parseInt(m[2]) / 60 : 0);
}

/** Extrae horas de una cadena de evento: "Inspección (2h 30min)" → 2.5 */
function parseEventHours(str) {
  if (!str) return 0;
  const m = str.match(/\(?(\d+)\s*h\s*(\d*)\s*m?(?:in)?\)?/i);
  if (!m) return 0;
  return parseInt(m[1]) + (m[2] ? parseInt(m[2]) / 60 : 0);
}

/** Palabras clave que justifican ausencia/menos horas */
const JUSTIFIED_RE = /festivo|vacaci[oó]n(es)?|previsi[oó]n|enferm(o|a|edad)?|\bbaja\b|accidente|licencia|permiso|\bIT\b/i;
function isJustifiedDay(events) {
  return (events || []).some(e => JUSTIFIED_RE.test(e));
}

// ─── Análisis IA – cumplimiento horario + diferencia fichaje/tareas ────────
// GET /api/analizar-empleado?empleado=SGG
app.get('/api/analizar-empleado', async (req, res) => {
  try {
    const empleado = (req.query.empleado || '').toUpperCase().trim();
    if (!empleado) return res.status(400).json({ ok: false, error: 'Falta parámetro empleado' });
    if (!db)       return res.status(503).json({ ok: false, error: 'DB no disponible' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)   return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY no configurada' });

    const doc = await db.collection('calendario_datos').findOne({ empleado });
    if (!doc) return res.status(404).json({ ok: false, error: `No hay datos de ${empleado}` });

    // Cargar tareas manuales para este empleado
    const tareasRaw = await db.collection('tareas_manuales').find({ empleado }).toArray();
    const tareasMap = {};
    tareasRaw.forEach(t => { tareasMap[t.fecha] = t.horas; });

    const semanas = doc.semanas || [];

    // ── Pre-computar datos enriquecidos ──────────────────────────────────
    let totalFichaje_h = 0, totalTareas_h = 0;

    const resumenSemanas = semanas.map(s => {
      const dias = (s.days || []).map(d => {
        const isWeekend   = d.weekday && ['sáb','sab','dom'].includes(d.weekday.toLowerCase());
        const fecha       = d.date || deriveDate(s.week, d.weekday);
        const justificadoEvento   = isJustifiedDay(d.events);
        const justificadoNacional = !isWeekend && isFestivoNacional(fecha);
        const justificado = justificadoEvento || justificadoNacional;
        const justDesc    = justificado
          ? ((d.events || []).find(e => JUSTIFIED_RE.test(e)) || (justificadoNacional ? 'Festivo nacional' : ''))
          : null;
        const fichaje_h   = parseTpcHours(d.tpc);
        const fichajeNull = fichaje_h === null || fichaje_h === 0;
        const sinDatos    = !isWeekend && !justificado && fichajeNull && (d.events || []).length === 0;

        // ── Horas de tareas: manual > badge negro > eventos ──────────────
        const tareas_h_manual = (fecha && tareasMap[fecha] !== undefined) ? tareasMap[fecha] : null;
        const tareas_h_badge  = parseTpcHours(d.previsto);
        const eventos = (d.events || []).map(ev => ({
          texto: ev.substring(0, 80),
          horas: parseEventHours(ev) || null
        }));
        const tareas_h_eventos = eventos.reduce((acc, ev) => acc + (ev.horas || 0), 0);
        const tareas_h_raw = tareas_h_manual !== null ? tareas_h_manual
                           : tareas_h_badge  !== null ? tareas_h_badge
                           : tareas_h_eventos > 0     ? tareas_h_eventos
                           : null;
        const tareas_h = tareas_h_raw !== null ? Math.round(tareas_h_raw * 100) / 100 : null;
        // Diferencia solo en días laborables activos (excluye festivos/vacaciones)
        const diferencia_h = (!justificado && !sinDatos && fichaje_h !== null && tareas_h !== null)
          ? Math.round((fichaje_h - tareas_h) * 100) / 100
          : null;

        if (!isWeekend && !justificado && fichaje_h !== null) totalFichaje_h += fichaje_h;
        if (!isWeekend && !justificado && tareas_h  !== null) totalTareas_h  += tareas_h;

        return {
          fecha: d.date, dia: d.weekday, esFinSemana: isWeekend,
          justificado, sinDatos, justDesc,
          fichaje: d.tpc || null, fichaje_h,
          eventos, tareas_h, diferencia_h
        };
      });

      // Diferencia semanal solo sobre días laborables activos
      const diasActivos = dias.filter(d => !d.esFinSemana && !d.justificado && !d.sinDatos);
      const semFichaje = diasActivos.filter(d => d.fichaje_h !== null)
                               .reduce((s, d) => s + d.fichaje_h, 0);
      const semTareas  = diasActivos.filter(d => d.tareas_h !== null)
                               .reduce((s, d) => s + d.tareas_h, 0);

      return {
        semana: s.week, etiqueta: s.weekLabel,
        tpcTotal: s.tpcTotal, previsto: s.previsto,
        semFichaje_h:    Math.round(semFichaje * 100) / 100,
        semTareas_h:     semTareas  > 0 ? Math.round(semTareas  * 100) / 100 : null,
        semDiferencia_h: semTareas  > 0 ? Math.round((semFichaje - semTareas) * 100) / 100 : null,
        dias
      };
    });

    totalFichaje_h = Math.round(totalFichaje_h * 100) / 100;
    totalTareas_h  = Math.round(totalTareas_h  * 100) / 100;
    const totalDiferencia_h = totalTareas_h > 0
      ? Math.round((totalFichaje_h - totalTareas_h) * 100) / 100
      : null;

    // ── Prompt para Claude ───────────────────────────────────────────────
    const prompt = `Eres un asistente de RRHH de SIMECAL. Analiza el cumplimiento horario del empleado ${empleado}.

DATOS ENRIQUECIDOS DEL CALENDARIO:
${JSON.stringify(resumenSemanas, null, 1)}

TOTALES GLOBALES PRE-CALCULADOS:
- Horas de fichaje (lun-vie): ${totalFichaje_h}h
- Horas de tareas registradas: ${totalTareas_h > 0 ? totalTareas_h + 'h' : 'sin tareas con duración explícita'}
- Diferencia total (fichaje − tareas): ${totalDiferencia_h !== null ? totalDiferencia_h + 'h' : 'N/A'}

REGLAS OBLIGATORIAS:
1. Jornada laboral = 8h diarias lun-vie (40h/semana).
2. Un día con justificado=true está TOTALMENTE JUSTIFICADO. Esto incluye cualquier variante de: FESTIVO, FESTIVO NACIONAL, FESTIVO LOCAL, FESTIVO REGIONAL, VACACIONES, VACACIONES PREVISTAS, PREVISIÓN DE VACACIONES, ENFERMO, ENFERMEDAD, BAJA, BAJA MÉDICA, IT, ACCIDENTE LABORAL, LICENCIA, PERMISO. Estos días NO son error ni alerta.
3. esFinSemana=true → ignorar completamente.
4. sinDatos=true → el día tiene 0h de fichaje y ningún evento registrado. Esto ocurre en festivos y vacaciones cuya información no fue capturada en la extracción. NO los cuentes como incumplimiento ni como alerta. Pueden aparecer como "días sin datos" en la nota de la semana pero nunca como error del empleado.
5. Un día INCUMPLE solo si: justificado=false AND sinDatos=false AND esFinSemana=false AND fichaje_h < 7.5 AND fichaje_h !== null.
6. DIFERENCIA HORARIA: fichaje_h = horas del badge verde (tiempo total fichado). tareas_h = horas del badge negro (suma de horas en actividades/tareas del día). diferencia_h = fichaje_h − tareas_h. Si diferencia_h > 1h: hay tiempo fichado no cubierto por tareas registradas (posible desplazamiento, admin, tiempo no registrado). Si diferencia_h < -0.5h: hay tareas con más horas que el fichaje (tareas fuera del horario fichado).

RESPONDE ÚNICAMENTE JSON (sin texto extra) con este formato:
{
  "empleado": "${empleado}",
  "resumenGeneral": "2-3 frases con el estado general del empleado",
  "cumplimientoGlobal": número 0-100,
  "totalFichaje_h": ${totalFichaje_h},
  "totalTareas_h": ${totalTareas_h || null},
  "totalDiferencia_h": ${totalDiferencia_h},
  "alertas": ["solo alertas de días NO justificados con horas insuficientes o anomalías reales"],
  "semanas": [
    {
      "semana": "YYYY-MM-DD",
      "etiqueta": "S X - mes YYYY",
      "tpcTotal": "XXh Ymin",
      "semFichaje_h": número,
      "semTareas_h": número o null,
      "semDiferencia_h": número o null,
      "cumple": true/false,
      "diasProblema": ["solo días NO justificados con < 7.5h: ej: lun 2026-01-12: 6h"],
      "nota": "breve nota opcional"
    }
  ],
  "recomendacion": "recomendación final"
}`;

    // ── Llamar a Claude API (o usar análisis local si no hay créditos) ──
    const useLocal = req.query.local === '1' || !apiKey;
    let analisis;

    if (!useLocal) {
      try {
        const anthropic = new Anthropic({ apiKey });
        const message = await anthropic.messages.create({
          model:      'claude-opus-4-5',
          max_tokens: 4096,
          messages:   [{ role: 'user', content: prompt }]
        });
        const raw = message.content[0].text;
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('Respuesta inválida de Claude');
        analisis = JSON.parse(jsonMatch[0]);
        analisis.totalFichaje_h    = analisis.totalFichaje_h    ?? totalFichaje_h;
        analisis.totalTareas_h     = analisis.totalTareas_h     ?? (totalTareas_h > 0 ? totalTareas_h : null);
        analisis.totalDiferencia_h = analisis.totalDiferencia_h ?? totalDiferencia_h;
      } catch (apiErr) {
        // Créditos agotados u otro error → fallback a análisis local
        console.warn('Claude API error, usando análisis local:', apiErr.message);
        analisis = computeLocalAnalysis(empleado, resumenSemanas, totalFichaje_h,
                                        totalTareas_h > 0 ? totalTareas_h : null,
                                        totalDiferencia_h);
      }
    } else {
      analisis = computeLocalAnalysis(empleado, resumenSemanas, totalFichaje_h,
                                      totalTareas_h > 0 ? totalTareas_h : null,
                                      totalDiferencia_h);
    }

    // diasData: datos diarios pre-computados para vistas Diario/Mensual en el frontend
    const diasData = resumenSemanas.map(s => ({
      semana:          s.semana,
      etiqueta:        s.etiqueta,
      semFichaje_h:    s.semFichaje_h,
      semTareas_h:     s.semTareas_h,
      semDiferencia_h: s.semDiferencia_h,
      dias: s.dias.map(d => ({
        fecha:        d.fecha,
        dia:          d.dia,
        esFinSemana:  d.esFinSemana,
        justificado:  d.justificado,
        sinDatos:     d.sinDatos,
        justDesc:     d.justDesc,
        fichaje_h:    d.fichaje_h,
        tareas_h:     d.tareas_h,
        diferencia_h: d.diferencia_h,
        eventos:      d.eventos
      }))
    }));

    res.json({ ok: true, analisis, diasData, extractedAt: doc.extractedAt });

  } catch (e) {
    console.error('/api/analizar-empleado error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Festivos nacionales España (fijos) ───────────────────────────────────
const FESTIVOS_ES = new Set([
  // 2025
  '2025-01-01','2025-01-06','2025-04-18','2025-05-01','2025-08-15',
  '2025-10-12','2025-11-01','2025-12-06','2025-12-08','2025-12-25',
  // 2026
  '2026-01-01','2026-01-06','2026-04-03','2026-05-01','2026-08-15',
  '2026-10-12','2026-11-01','2026-12-06','2026-12-08','2026-12-25',
]);
function isFestivoNacional(fecha) {
  return fecha ? FESTIVOS_ES.has(fecha) : false;
}

// ─── Resumen Calendario (sin IA) ──────────────────────────────────────────

/** Deriva la fecha ISO a partir del inicio de semana (lunes) + día de la semana */
function deriveDate(weekStart, weekday) {
  if (!weekStart || !weekday) return null;
  const wd = weekday.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').substring(0, 3);
  const map = { lun:0, mar:1, mie:2, jue:3, vie:4, sab:5, dom:6 };
  const offset = map[wd];
  if (offset === undefined) return null;
  const d = new Date(weekStart + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// Devuelve el lunes de la semana que contiene dateStr (YYYY-MM-DD)
function getMondayISO(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=dom
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Calcula el mismo resumen que computeCalResumen pero a partir de dos mapas
// { "YYYY-MM-DD": horas } en lugar de datos extraídos de SIMECAL
function computeManualResumen(empCode, fichajesMap, tareasMap) {
  const allDates = [...new Set([
    ...Object.keys(fichajesMap),
    ...Object.keys(tareasMap)
  ])].sort();
  if (allDates.length === 0) return null;

  // Agrupar por semana (lunes)
  const weeksMap = {};
  allDates.forEach(f => {
    const w = getMondayISO(f);
    if (!weeksMap[w]) weeksMap[w] = new Set();
    weeksMap[w].add(f);
  });

  let totalFichaje_h = 0, totalTareas_h = 0;
  let diasLaborables = 0, diasCumplen = 0, diasJustif = 0, diasSinDatos = 0, diasIncumple = 0;
  const DAY_NAMES = ['lun','mar','mie','jue','vie','sáb','dom'];

  const semanasData = Object.keys(weeksMap).sort().map(weekStart => {
    const dias = [];
    for (let offset = 0; offset < 7; offset++) {
      const d = new Date(weekStart + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + offset);
      const fecha      = d.toISOString().slice(0, 10);
      const dia        = DAY_NAMES[offset];
      const esFinSemana = offset >= 5;
      const justificado = !esFinSemana && isFestivoNacional(fecha);
      const fichaje_h  = fichajesMap[fecha] !== undefined ? fichajesMap[fecha] : null;
      const tareas_h   = tareasMap[fecha]   !== undefined ? tareasMap[fecha]   : null;
      const sinDatos   = !esFinSemana && !justificado && fichaje_h === null;
      const diferencia_h = (!esFinSemana && !justificado && !sinDatos
        && fichaje_h !== null && tareas_h !== null)
        ? Math.round((fichaje_h - tareas_h) * 100) / 100 : null;

      if (!esFinSemana) {
        if (justificado)         diasJustif++;
        else if (sinDatos)       diasSinDatos++;
        else if (fichaje_h !== null) {
          diasLaborables++;
          if (fichaje_h >= 7.5 && fichaje_h <= 8.5) diasCumplen++; else diasIncumple++;
          totalFichaje_h += fichaje_h;
          if (tareas_h !== null) totalTareas_h += tareas_h;
        }
      }
      dias.push({ fecha, dia, esFinSemana, justificado,
        justDesc: justificado ? 'Festivo nacional' : null,
        sinDatos, fichaje_h, tareas_h, diferencia_h, eventos: [] });
    }

    const activos    = dias.filter(d => !d.esFinSemana && !d.justificado && !d.sinDatos && d.fichaje_h !== null);
    const semFich    = activos.reduce((s, d) => s + d.fichaje_h, 0);
    const semTar     = activos.filter(d => d.tareas_h !== null).reduce((s, d) => s + d.tareas_h, 0);
    const conDiff    = dias.filter(d => d.diferencia_h !== null);
    const semDiff    = conDiff.reduce((s, d) => s + d.diferencia_h, 0);
    const cumple     = activos.length === 0 ? null : activos.every(d => d.fichaje_h >= 7.5 && d.fichaje_h <= 8.5);

    return {
      semana:              weekStart,
      etiqueta:            '',
      semFichaje_h:        Math.round(semFich * 100) / 100,
      semFichajeActivo_h:  Math.round(semFich * 100) / 100,
      semTareas_h:         activos.some(d => d.tareas_h !== null) ? Math.round(semTar * 100) / 100 : null,
      semDiferencia_h:     conDiff.length > 0 ? Math.round(semDiff * 100) / 100 : null,
      cumple,
      semJustif:           dias.filter(d => !d.esFinSemana && d.justificado).length,
      dias
    };
  });

  totalFichaje_h = Math.round(totalFichaje_h * 100) / 100;
  totalTareas_h  = Math.round(totalTareas_h  * 100) / 100;
  const allConDiff      = semanasData.flatMap(s => s.dias).filter(d => d.diferencia_h !== null);
  const totalDiferencia_h = allConDiff.length > 0
    ? Math.round(allConDiff.reduce((s, d) => s + d.diferencia_h, 0) * 100) / 100 : null;
  const cumplimientoPct = diasLaborables > 0
    ? Math.round((diasCumplen / diasLaborables) * 100) : 0;

  return {
    empleado: empCode,
    extractedAt: new Date().toISOString(),
    fuente: 'manual',
    totalSemanas: semanasData.length,
    totalFichaje_h, totalTareas_h, totalDiferencia_h,
    diasLaborables, diasCumplen, diasIncumple, diasJustif, diasSinDatos,
    cumplimientoPct, semanasData
  };
}

// Helper: devuelve true si el doc SIMECAL tiene al menos 1 día con horas de fichaje reales
function simecalTieneFichaje(doc) {
  if (!doc || !doc.semanas || doc.semanas.length === 0) return false;
  return doc.semanas.some(s =>
    (s.days || []).some(d => {
      const h = parseTpcHours(d.tpc);
      return h !== null && h > 0;
    })
  );
}

// Helper: computa métricas para un documento de calendario
function computeCalResumen(doc, tareasMap = {}) {
  const semanas = doc.semanas || [];
  let totalFichaje_h = 0, totalTareas_h = 0;
  let diasLaborables = 0, diasCumplen = 0, diasJustif = 0, diasSinDatos = 0, diasIncumple = 0;

  const semanasData = semanas.map(s => {
    const dias = (s.days || []).map((d, idx) => {
      const isWeekend   = d.weekday && ['sáb','sab','dom'].includes(d.weekday.toLowerCase());
      // Derivar fecha si no está presente
      const fecha = d.date || deriveDate(s.week, d.weekday);
      // Justificado: por evento extraído O por ser festivo nacional de España
      const justificadoEvento  = isJustifiedDay(d.events);
      const justificadoNacional = !isWeekend && isFestivoNacional(fecha);
      const justificado = justificadoEvento || justificadoNacional;
      const justDesc    = justificado
        ? ((d.events || []).find(e => JUSTIFIED_RE.test(e)) || (justificadoNacional ? 'Festivo nacional' : ''))
        : null;
      const fichaje_h   = parseTpcHours(d.tpc);
      const fichajeNull = fichaje_h === null || fichaje_h === 0;
      const sinDatos    = !isWeekend && !justificado && fichajeNull && (d.events || []).length === 0;

      const tareas_h_manual = (fecha && tareasMap[fecha] !== undefined) ? tareasMap[fecha] : null;
      const tareas_h_badge  = parseTpcHours(d.previsto);
      const tareas_h_evts   = (d.events || []).reduce((a, ev) => a + parseEventHours(ev), 0);
      const tareas_h_raw    = tareas_h_manual !== null ? tareas_h_manual
                            : tareas_h_badge  !== null ? tareas_h_badge
                            : tareas_h_evts   > 0      ? tareas_h_evts : null;
      const tareas_h        = tareas_h_raw !== null ? Math.round(tareas_h_raw * 100) / 100 : null;
      // Diferencia solo en días laborables activos (no festivos, no sinDatos)
      const diferencia_h    = (!justificado && !sinDatos && fichaje_h !== null && tareas_h !== null)
        ? Math.round((fichaje_h - tareas_h) * 100) / 100 : null;

      if (!isWeekend) {
        // Totales globales: solo días activos (no festivos)
        if (!justificado && fichaje_h !== null) totalFichaje_h += fichaje_h;
        if (!justificado && tareas_h  !== null) totalTareas_h  += tareas_h;
        if (justificado)         diasJustif++;
        else if (sinDatos)       diasSinDatos++;
        else if (fichaje_h !== null) {
          diasLaborables++;
          if (fichaje_h >= 7.5 && fichaje_h <= 8.5) diasCumplen++;
          else                                        diasIncumple++;
        }
      }

      return {
        fecha, dia: d.weekday, esFinSemana: isWeekend,
        justificado, sinDatos, justDesc,
        fichaje: d.tpc || null, fichaje_h,
        tareas_h, diferencia_h,
        eventos: (d.events || []).map(e => e.substring(0, 100))
      };
    });

    // Fichaje total de la semana (todos los días, para información)
    const semFichajeTotal = dias.filter(d => !d.esFinSemana && d.fichaje_h !== null)
                                .reduce((s, d) => s + d.fichaje_h, 0);
    // Tareas y cumplimiento: solo días laborables activos
    const diasActivos = dias.filter(d => !d.esFinSemana && !d.justificado && !d.sinDatos);
    const semFichajeActivo = diasActivos.filter(d => d.fichaje_h !== null)
                                        .reduce((s, d) => s + d.fichaje_h, 0);
    const semTareas  = diasActivos.filter(d => d.tareas_h !== null)
                           .reduce((s, d) => s + d.tareas_h, 0);
    const semLab     = diasActivos.filter(d => d.fichaje_h !== null);
    const semCumple  = semLab.length === 0 ? null : semLab.every(d => d.fichaje_h >= 7.5 && d.fichaje_h <= 8.5);
    // Días justificados en la semana
    const semJustif  = dias.filter(d => !d.esFinSemana && d.justificado).length;
    // Diferencia semanal = SUMA de (fichaje_dia − tareas_dia) solo días con ambos valores
    const diasConDiff = dias.filter(d => d.diferencia_h !== null);
    const semDiferencia = diasConDiff.reduce((s, d) => s + d.diferencia_h, 0);

    return {
      semana: s.week, etiqueta: s.weekLabel || '',
      tpcTotal: s.tpcTotal, previsto: s.previsto,
      kmTotal: s.kmTotal,
      semFichaje_h:       Math.round(semFichajeTotal * 100) / 100,     // total real semana
      semFichajeActivo_h: Math.round(semFichajeActivo * 100) / 100,    // solo días activos
      semTareas_h:        semTareas > 0 ? Math.round(semTareas * 100) / 100 : null,
      semDiferencia_h:    diasConDiff.length > 0 ? Math.round(semDiferencia * 100) / 100 : null,
      cumple: semCumple,
      semJustif,
      dias
    };
  });

  totalFichaje_h = Math.round(totalFichaje_h * 100) / 100;
  totalTareas_h  = Math.round(totalTareas_h  * 100) / 100;
  // Diferencia total = SUMA de diferencia_h por día (fichaje_dia − tareas_dia por cada día válido)
  const _allDiasConDiff = semanasData.flatMap(s => s.dias).filter(d => d.diferencia_h !== null);
  const totalDiferencia_h = _allDiasConDiff.length > 0
    ? Math.round(_allDiasConDiff.reduce((s, d) => s + d.diferencia_h, 0) * 100) / 100 : null;
  const cumplimientoPct = diasLaborables > 0
    ? Math.round((diasCumplen / diasLaborables) * 100) : null;

  return {
    empleado: doc.empleado,
    extractedAt: doc.extractedAt,
    totalSemanas: semanas.length,
    totalFichaje_h, totalTareas_h, totalDiferencia_h,
    diasLaborables, diasCumplen, diasIncumple, diasJustif, diasSinDatos,
    cumplimientoPct,
    semanasData
  };
}

// GET /api/resumen-calendario        → lista con métricas de todos los empleados
app.get('/api/resumen-calendario', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'DB no disponible' });

    // Cargar las tres fuentes en paralelo
    const [docs, allTareas, allFichs] = await Promise.all([
      db.collection('calendario_datos').find({}).toArray(),
      db.collection('tareas_manuales').find({}).toArray(),
      db.collection('fichajes_manuales').find({}).toArray()
    ]);

    // Construir mapas por empleado
    const tareasMapByEmp = {}, fichsMapByEmp = {};
    allTareas.forEach(t => {
      if (!tareasMapByEmp[t.empleado]) tareasMapByEmp[t.empleado] = {};
      tareasMapByEmp[t.empleado][t.fecha] = t.horas;
    });
    allFichs.forEach(f => {
      if (!fichsMapByEmp[f.empleado]) fichsMapByEmp[f.empleado] = {};
      fichsMapByEmp[f.empleado][f.fecha] = f.horas;
    });

    const resultado = [];
    const simecalEmps = new Set(docs.map(d => d.empleado));

    // 1. Empleados con datos SIMECAL
    for (const doc of docs) {
      let r;
      if (!simecalTieneFichaje(doc) && fichsMapByEmp[doc.empleado]) {
        // SIMECAL sin horas de fichaje reales pero tiene fichajes manuales → usar manuales
        r = computeManualResumen(doc.empleado, fichsMapByEmp[doc.empleado], tareasMapByEmp[doc.empleado] || {});
      }
      if (!r) r = computeCalResumen(doc, tareasMapByEmp[doc.empleado] || {});
      const { semanasData, ...summary } = r;
      resultado.push(summary);
    }

    // 2. Empleados sólo con fichajes manuales (no están en SIMECAL)
    for (const emp of Object.keys(fichsMapByEmp)) {
      if (simecalEmps.has(emp)) continue;
      const r = computeManualResumen(emp, fichsMapByEmp[emp], tareasMapByEmp[emp] || {});
      if (!r) continue;
      const { semanasData, ...summary } = r;
      resultado.push(summary);
    }

    // 3. Empleados sólo con tareas manuales (sin SIMECAL ni fichajes)
    for (const emp of Object.keys(tareasMapByEmp)) {
      if (simecalEmps.has(emp)) continue;
      if (fichsMapByEmp[emp]) continue; // ya cubierto arriba
      const r = computeManualResumen(emp, {}, tareasMapByEmp[emp]);
      if (!r) continue;
      const { semanasData, ...summary } = r;
      resultado.push(summary);
    }

    resultado.sort((a, b) => a.empleado.localeCompare(b.empleado));
    res.json({ ok: true, empleados: resultado });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/resumen-calendario/:empleado  → detalle completo de un empleado
app.get('/api/resumen-calendario/:empleado', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'DB no disponible' });
    const empCode = req.params.empleado.toUpperCase();

    const [doc, tareasRaw, fichsRaw] = await Promise.all([
      db.collection('calendario_datos').findOne({ empleado: empCode }),
      db.collection('tareas_manuales').find({ empleado: empCode }).toArray(),
      db.collection('fichajes_manuales').find({ empleado: empCode }).toArray()
    ]);

    const tareasMap = {};
    tareasRaw.forEach(t => { tareasMap[t.fecha] = t.horas; });

    let result;
    if (simecalTieneFichaje(doc)) {
      // SIMECAL tiene horas reales → usarlo (+ tareas manuales como overlay)
      result = computeCalResumen(doc, tareasMap);
    } else if (fichsRaw.length > 0) {
      // Sin fichaje SIMECAL pero tiene fichajes manuales
      const fichsMap = {};
      fichsRaw.forEach(f => { fichsMap[f.fecha] = f.horas; });
      result = computeManualResumen(empCode, fichsMap, tareasMap);
      if (!result) return res.status(404).json({ ok: false, error: `Sin datos para ${empCode}` });
    } else if (Object.keys(tareasMap).length > 0) {
      // Solo tiene tareas manuales (sin fichajes ni SIMECAL)
      result = computeManualResumen(empCode, {}, tareasMap);
      if (!result) return res.status(404).json({ ok: false, error: `Sin datos para ${empCode}` });
    } else if (doc) {
      // Doc SIMECAL existe pero sin datos útiles → mostrar vacío
      result = computeCalResumen(doc, tareasMap);
    } else {
      return res.status(404).json({ ok: false, error: `No hay datos de ${empCode}` });
    }

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/diagnostico  → revisión del estado de datos por empleado
app.get('/api/diagnostico', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'DB no disponible' });

    const [calDocs, allTareas, allFichs] = await Promise.all([
      db.collection('calendario_datos').find({}, { projection: { empleado:1, semanas:1 } }).toArray(),
      db.collection('tareas_manuales').distinct('empleado'),
      db.collection('fichajes_manuales').distinct('empleado')
    ]);

    const tareasSet = new Set(allTareas);
    const fichsSet  = new Set(allFichs);
    const simecalSet = new Set(calDocs.map(d => d.empleado));

    const reporte = [];

    // Empleados con doc SIMECAL
    for (const doc of calDocs) {
      const tieneFich = simecalTieneFichaje(doc);
      const tieneMFich = fichsSet.has(doc.empleado);
      const tieneTareas = tareasSet.has(doc.empleado);
      let fuente;
      if (tieneFich) fuente = 'SIMECAL';
      else if (tieneMFich) fuente = 'manual-fichajes';
      else if (tieneTareas) fuente = 'solo-tareas';
      else fuente = 'sin-datos';

      reporte.push({
        empleado: doc.empleado,
        simecal_semanas: (doc.semanas || []).length,
        simecal_tiene_fichaje: tieneFich,
        tiene_fichajes_manuales: tieneMFich,
        tiene_tareas_manuales: tieneTareas,
        fuente_activa: fuente,
        estado: tieneFich ? '✅ SIMECAL OK'
          : tieneMFich   ? '✅ Manual fichajes OK'
          : tieneTareas  ? '⚠️  Solo tareas (sin fichajes)'
          : '❌ Sin datos útiles'
      });
    }

    // Empleados solo manuales (sin doc SIMECAL)
    const soloManual = [...new Set([...allTareas, ...allFichs])].filter(e => !simecalSet.has(e));
    for (const emp of soloManual) {
      reporte.push({
        empleado: emp,
        simecal_semanas: 0,
        simecal_tiene_fichaje: false,
        tiene_fichajes_manuales: fichsSet.has(emp),
        tiene_tareas_manuales: tareasSet.has(emp),
        fuente_activa: fichsSet.has(emp) ? 'manual-fichajes' : 'solo-tareas',
        estado: fichsSet.has(emp) ? '✅ Manual fichajes OK' : '⚠️  Solo tareas (sin fichajes)'
      });
    }

    reporte.sort((a, b) => a.empleado.localeCompare(b.empleado));

    const resumen = {
      total: reporte.length,
      simecal_ok: reporte.filter(e => e.fuente_activa === 'SIMECAL').length,
      manual_fichajes: reporte.filter(e => e.fuente_activa === 'manual-fichajes').length,
      solo_tareas: reporte.filter(e => e.fuente_activa === 'solo-tareas').length,
      sin_datos: reporte.filter(e => e.fuente_activa === 'sin-datos').length,
      problemas: reporte.filter(e => e.fuente_activa === 'sin-datos' || e.fuente_activa === 'solo-tareas').map(e => e.empleado)
    };

    res.json({ ok: true, resumen, empleados: reporte });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Fichajes Manuales ────────────────────────────────────────────────────
// Formato Excel: columna A = Empleado, B = Fecha, C = Horas  (igual que tareas)

function parseExcelSimple(buffer) {
  const wb    = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const records = []; let skipped = 0;
  for (const row of rows) {
    if (!row || row.length < 3) continue;
    const c0 = String(row[0] || '').trim();
    const c1 = String(row[1] || '').trim();
    const c2 = String(row[2] || '').trim();
    if (!c0 || /^empleado|^emp|^c[oó]d/i.test(c0)) continue;
    const empleado = c0.toUpperCase();
    let fecha = null;
    if (typeof row[1] === 'number') {
      const dd = XLSX.SSF.parse_date_code(row[1]);
      fecha = `${dd.y}-${String(dd.m).padStart(2,'0')}-${String(dd.d).padStart(2,'0')}`;
    } else {
      const m1 = c1.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (m1) fecha = `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
      const m2 = c1.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      if (!fecha && m2) fecha = `${m2[1]}-${m2[2].padStart(2,'0')}-${m2[3].padStart(2,'0')}`;
    }
    if (!fecha) { skipped++; continue; }
    let horas = null;
    if (typeof row[2] === 'number') { horas = Math.round(row[2] * 100) / 100; }
    else {
      const mt = c2.match(/^(\d+):(\d{2})$/);
      if (mt) horas = parseInt(mt[1]) + parseInt(mt[2]) / 60;
      else    horas = parseFloat(c2.replace(',', '.'));
    }
    if (horas === null || isNaN(horas) || horas < 0) { skipped++; continue; }
    records.push({ empleado, fecha, horas: Math.round(horas * 100) / 100 });
  }
  return { records, skipped };
}

app.post('/api/fichajes-manuales', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No se recibió archivo' });
    const { records, skipped } = parseExcelSimple(req.file.buffer);
    if (records.length === 0)
      return res.status(400).json({ ok: false, error: 'Sin registros válidos. Formato: Empleado | Fecha | Horas' });
    if (!db) return res.status(503).json({ ok: false, error: 'Base de datos no disponible' });
    const ops = records.map(r => ({
      updateOne: {
        filter: { empleado: r.empleado, fecha: r.fecha },
        update: { $set: { ...r, updatedAt: new Date() } },
        upsert: true
      }
    }));
    await db.collection('fichajes_manuales').bulkWrite(ops);
    const summary = {};
    records.forEach(r => { summary[r.empleado] = (summary[r.empleado] || 0) + 1; });
    res.json({ ok: true, total: records.length, skipped, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/fichajes-manuales', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'DB no disponible' });
    const docs = await db.collection('fichajes_manuales')
      .find({}).sort({ empleado: 1, fecha: 1 }).toArray();
    const byEmp = {};
    docs.forEach(d => {
      if (!byEmp[d.empleado]) byEmp[d.empleado] = { empleado: d.empleado, dias: 0, totalHoras: 0, fechaMin: d.fecha, fechaMax: d.fecha };
      const e = byEmp[d.empleado];
      e.dias++; e.totalHoras = Math.round((e.totalHoras + d.horas) * 100) / 100;
      if (d.fecha < e.fechaMin) e.fechaMin = d.fecha;
      if (d.fecha > e.fechaMax) e.fechaMax = d.fecha;
    });
    res.json({ ok: true, empleados: Object.values(byEmp), total: docs.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/fichajes-manuales/:empleado', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'DB no disponible' });
    const emp    = req.params.empleado.toUpperCase();
    const filter = emp === 'ALL' ? {} : { empleado: emp };
    const r = await db.collection('fichajes_manuales').deleteMany(filter);
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Tareas Manuales ──────────────────────────────────────────────────────
// Formato Excel esperado: columna A = Empleado, B = Fecha, C = Horas
// Fechas aceptadas: DD/MM/YYYY, YYYY-MM-DD o número serial de Excel

// POST /api/tareas-manuales  (multipart, campo "file")
app.post('/api/tareas-manuales', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No se recibió archivo' });

    const wb    = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    const records = [];
    let skipped = 0;

    for (const row of rows) {
      if (!row || row.length < 3) continue;
      const c0 = String(row[0] || '').trim();
      const c1 = String(row[1] || '').trim();
      const c2 = String(row[2] || '').trim();
      if (!c0 || /^empleado|^emp|^c[oó]digo/i.test(c0)) continue; // cabecera

      const empleado = c0.toUpperCase();

      // Parse fecha → YYYY-MM-DD
      let fecha = null;
      if (typeof row[1] === 'number') {
        const d = XLSX.SSF.parse_date_code(row[1]);
        fecha = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
      } else {
        const m1 = c1.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (m1) fecha = `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
        const m2 = c1.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
        if (!fecha && m2) fecha = `${m2[1]}-${m2[2].padStart(2,'0')}-${m2[3].padStart(2,'0')}`;
      }
      if (!fecha) { skipped++; continue; }

      // Parse horas (decimal o "H:MM")
      let horas = null;
      if (typeof row[2] === 'number') {
        horas = Math.round(row[2] * 100) / 100;
      } else {
        const mTime = c2.match(/^(\d+):(\d{2})$/);
        if (mTime) horas = parseInt(mTime[1]) + parseInt(mTime[2]) / 60;
        else       horas = parseFloat(c2.replace(',', '.'));
      }
      if (horas === null || isNaN(horas) || horas < 0) { skipped++; continue; }

      records.push({ empleado, fecha, horas: Math.round(horas * 100) / 100 });
    }

    if (records.length === 0)
      return res.status(400).json({ ok: false, error: 'No se encontraron registros válidos. Formato esperado: Empleado | Fecha | Horas' });

    if (!db) return res.status(503).json({ ok: false, error: 'Base de datos no disponible' });
    const ops = records.map(r => ({
      updateOne: {
        filter: { empleado: r.empleado, fecha: r.fecha },
        update: { $set: { ...r, updatedAt: new Date() } },
        upsert: true
      }
    }));
    await db.collection('tareas_manuales').bulkWrite(ops);

    // Resumen por empleado
    const summary = {};
    records.forEach(r => { summary[r.empleado] = (summary[r.empleado] || 0) + 1; });

    res.json({ ok: true, total: records.length, skipped, summary });
  } catch (e) {
    console.error('/api/tareas-manuales POST error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/tareas-manuales  → resumen por empleado + últimos registros
app.get('/api/tareas-manuales', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'DB no disponible' });
    const docs = await db.collection('tareas_manuales')
      .find({}).sort({ empleado: 1, fecha: 1 }).toArray();

    const byEmp = {};
    docs.forEach(d => {
      if (!byEmp[d.empleado]) byEmp[d.empleado] = {
        empleado: d.empleado, dias: 0, totalHoras: 0, fechaMin: d.fecha, fechaMax: d.fecha
      };
      const e = byEmp[d.empleado];
      e.dias++;
      e.totalHoras = Math.round((e.totalHoras + d.horas) * 100) / 100;
      if (d.fecha < e.fechaMin) e.fechaMin = d.fecha;
      if (d.fecha > e.fechaMax) e.fechaMax = d.fecha;
    });

    res.json({ ok: true, empleados: Object.values(byEmp), total: docs.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/tareas-manuales/:empleado  (o "all" para borrar todo)
app.delete('/api/tareas-manuales/:empleado', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'DB no disponible' });
    const emp    = req.params.empleado.toUpperCase();
    const filter = emp === 'ALL' ? {} : { empleado: emp };
    const r = await db.collection('tareas_manuales').deleteMany(filter);
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Iniciar servidor ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Servidor corriendo en http://localhost:${PORT}`);
});
