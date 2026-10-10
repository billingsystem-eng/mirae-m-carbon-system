// Sends email through any SMTP server (Gmail/Google Workspace, Microsoft 365, Mailgun, SendGrid, your own).
// Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM in .env. Until SMTP_HOST and MAIL_FROM are set,
// reminders still appear inside the system and the emails wait in the outbox.
let transport = null;

const configured = () => !!(process.env.SMTP_HOST && process.env.MAIL_FROM);

function getTransport() {
  if (!transport) {
    const nodemailer = require('nodemailer'); // loaded here so a missing install shows up as a failed email, not a crash
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',            // true for port 465
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
    });
  }
  return transport;
}

async function send(to, subject, text) {
  await getTransport().sendMail({ from: process.env.MAIL_FROM, to, subject, text });
}

module.exports = { configured, send };
