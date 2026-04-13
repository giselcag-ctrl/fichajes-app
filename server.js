const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Firma corporativa ─────────────────────────────────────────────────────
const FIRMA = `

--
Carolina González Serrano
Delegado Comercial – SIMECAL
📧 cgs@simecal.com | 📞 604 56 16 20 | 📲 WhatsApp: 673 42 68 34
Cobertura Nacional – Oficinas e inspectores en todo el territorio
<< Detectamos riesgos para evitar accidentes >>`;

// ─── Configuración SMTP ────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: 'mail.simecal.com',
  port: 465,       // 465 = SSL  |  587 = TLS/STARTTLS
  secure: true,    // true para puerto 465, false para 587
  auth: {
    user: 'cgs@simecal.com',
    pass: process.env.SMTP_PASS
  }
});

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Ruta principal ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Endpoint: enviar un correo ────────────────────────────────────────────
app.post('/send-email', async (req, res) => {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ ok: false, error: 'Faltan campos: to, subject, body' });
  }

  try {
    const info = await transporter.sendMail({
      from: '"Carolina González – SIMECAL" <cgs@simecal.com>',
      to,
      subject,
      text: body + FIRMA
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    console.error('Error al enviar correo:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Endpoint: enviar todos los correos del día ────────────────────────────
app.post('/send-all-emails', async (req, res) => {
  const { emails } = req.body; // array de { to, subject, body }

  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ ok: false, error: 'Se esperaba un array "emails"' });
  }

  const results = [];
  for (const mail of emails) {
    try {
      const info = await transporter.sendMail({
        from: '"Carolina González – SIMECAL" <cgs@simecal.com>',
        to: mail.to,
        subject: mail.subject,
        text: mail.body + FIRMA
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
