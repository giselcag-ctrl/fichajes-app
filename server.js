const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
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
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: 'giselcag@gmail.com',
    pass: process.env.SMTP_PASS   // App Password de Google (16 caracteres)
  }
});

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// ─── Endpoint: enviar un correo ────────────────────────────────────────────
app.post('/send-email', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body)
    return res.status(400).json({ ok: false, error: 'Faltan campos: to, subject, body' });
  try {
    const info = await transporter.sendMail({
      from: '"Carolina González – SIMECAL" <giselcag@gmail.com>',
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
  const { emails } = req.body;
  if (!Array.isArray(emails) || emails.length === 0)
    return res.status(400).json({ ok: false, error: 'Se esperaba un array "emails"' });
  const results = [];
  for (const mail of emails) {
    try {
      const info = await transporter.sendMail({
        from: '"Carolina González – SIMECAL" <giselcag@gmail.com>',
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

// ─── Iniciar servidor ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Servidor corriendo en http://localhost:${PORT}`);
});
