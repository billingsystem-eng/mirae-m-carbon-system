// Profile pictures. Every signed-in user can set or remove their own; an administrator can remove anyone's.
// Files live on disk under DATA_DIR/uploads/avatars (one per user); the database keeps the file name and a
// version counter (users.avatar_v) that the pages add to the image URL so a new picture shows straight away.
// Upload is a plain binary POST, like the Sales Invoice scans. The browser crops and shrinks the photo first;
// the server still checks the type, the file signature and the size on its own.
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const audit = require('../lib/audit');

const router = express.Router();
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));   // absolute: res.sendFile rejects relative paths
const DIR = path.join(DATA_DIR, 'uploads', 'avatars');
fs.mkdirSync(DIR, { recursive: true });

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = {
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: '.png', magic: (b) => b.length > 4 && b.slice(1, 4).toString('latin1') === 'PNG' },
  'image/webp': { ext: '.webp', magic: (b) => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' }
};

const removeFile = (name) => { if (name) fs.promises.unlink(path.join(DIR, path.basename(name))).catch(() => {}); };

// Clear a user's picture (file + record).
function clear(userId) {
  const u = db.prepare('SELECT avatar_file FROM users WHERE id = ?').get(userId);
  if (!u) return false;
  db.prepare('UPDATE users SET avatar_file = NULL, avatar_v = 0 WHERE id = ?').run(userId);   // 0 = no picture, so the pages show the default icon and hide "Remove photo"
  removeFile(u.avatar_file);
  return true;
}

// Set own picture.
router.post('/me', express.raw({ type: () => true, limit: MAX_BYTES }), (req, res) => {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const spec = TYPES[type];
  if (!spec) return res.status(400).json({ error: 'Use a JPG, PNG or WebP picture.' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Choose a picture first.' });
  if (!spec.magic(buf)) return res.status(400).json({ error: 'That file is not a valid picture.' });

  const id = req.session.userId;
  const old = db.prepare('SELECT avatar_file FROM users WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: 'User not found.' });
  const name = `${id}-${Date.now()}${spec.ext}`;
  fs.writeFileSync(path.join(DIR, name), buf);
  db.prepare('UPDATE users SET avatar_file = ?, avatar_v = avatar_v + 1 WHERE id = ?').run(name, id);
  removeFile(old.avatar_file);
  audit.log(req, 'user', id, 'avatar', 'Changed own profile picture');
  res.json({ avatar_v: db.prepare('SELECT avatar_v FROM users WHERE id = ?').get(id).avatar_v });
});

// Remove own picture.
router.delete('/me', (req, res) => {
  if (!clear(req.session.userId)) return res.status(404).json({ error: 'User not found.' });
  audit.log(req, 'user', req.session.userId, 'avatar', 'Removed own profile picture');
  res.json({ avatar_v: 0 });
});

// Administrators can remove anyone's picture.
router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (!clear(id)) return res.status(404).json({ error: 'User not found.' });
  audit.log(req, 'user', id, 'avatar', 'Removed a profile picture');
  res.json({ ok: true });
});

// Show a picture. Staff can see everyone's; a client login only its own and Mirae ESP staff's.
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT id, role, avatar_file FROM users WHERE id = ?').get(id);
  if (!u || !u.avatar_file) return res.status(404).end();
  if (req.session.role === 'viewer' && u.id !== req.session.userId && u.role === 'viewer') return res.status(404).end();
  const full = path.join(DIR, path.basename(u.avatar_file));
  if (!fs.existsSync(full)) return res.status(404).end();
  const type = Object.keys(TYPES).find((t) => TYPES[t].ext === path.extname(full)) || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-cache');   // always revalidate (cheap 304), so a replaced picture can never show stale
  res.sendFile(full);
});

module.exports = router;
