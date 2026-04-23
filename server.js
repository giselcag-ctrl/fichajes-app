require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS – permite peticiones desde extensiones Chrome y la web ───────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

// ─── Iniciar servidor ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Servidor corriendo en http://localhost:${PORT}`);
});
