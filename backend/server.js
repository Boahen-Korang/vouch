require('dotenv').config();
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const cors     = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const dbUrl = process.env.DATABASE_URL || '';
console.log('DATABASE_URL set:', !!dbUrl);
console.log('DATABASE_URL prefix:', dbUrl.slice(0, 30) + '...');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('.internal') ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        email_verified BOOLEAN DEFAULT FALSE,
        joined VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS otps (
        email VARCHAR(255) PRIMARY KEY,
        code VARCHAR(6) NOT NULL,
        username VARCHAR(50),
        password_hash VARCHAR(255),
        expires_at TIMESTAMP NOT NULL
      );
      CREATE TABLE IF NOT EXISTS site_config (
        id INTEGER PRIMARY KEY,
        data JSONB DEFAULT '{}'
      );
    `);
    console.log('DB tables ready');
  } catch (e) {
    console.error('DB init failed:', e.message);
  }
}
initDb();

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

function otp6() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOtpEmail(to, code) {
  await mailer.sendMail({
    from: `"Vouch" <${process.env.GMAIL_USER}>`,
    to,
    subject: 'Your Vouch verification code',
    html: `
      <div style="font-family:sans-serif;max-width:400px;margin:0 auto;background:#0A1610;color:#ECEEE7;padding:32px;border-radius:16px">
        <h2 style="margin:0 0 8px;color:#3FD98C">Confirm your Vouch account</h2>
        <p style="color:#90A89A;margin:0 0 24px">Enter this code to verify your email address:</p>
        <div style="font-family:monospace;font-size:40px;font-weight:700;letter-spacing:10px;color:#ECEEE7;background:#13271C;padding:20px;border-radius:10px;text-align:center">${code}</div>
        <p style="color:#5E7568;font-size:13px;margin:20px 0 0">This code expires in 10 minutes. Do not share it with anyone.</p>
      </div>`,
  });
}

/* ── REGISTER ── */
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Missing fields' });
  try {
    const { rows: emailRows } = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (emailRows.length) return res.status(400).json({ error: 'Email already registered' });

    const { rows: unRows } = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    if (unRows.length) return res.status(400).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const code = otp6();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO otps (email, code, username, password_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET code=$2, username=$3, password_hash=$4, expires_at=$5`,
      [email.toLowerCase(), code, username, hash, expires]
    );
    await sendOtpEmail(email, code);
    res.json({ success: true });
  } catch (err) {
    console.error('REGISTER ERROR:', err.message);
    if (err.message?.includes('relation') || err.message?.includes('does not exist'))
      return res.status(500).json({ error: 'Database tables not set up — run schema.sql on Render PostgreSQL' });
    if (err.message?.includes('EAUTH') || err.message?.includes('Invalid login') || err.message?.includes('credentials'))
      return res.status(500).json({ error: 'Email config error — check GMAIL_USER and GMAIL_APP_PASSWORD in Render env vars' });
    if (err.message?.includes('connect') || err.message?.includes('ECONNREFUSED') || err.message?.includes('password authentication'))
      return res.status(500).json({ error: 'Database connection failed — check DATABASE_URL in Render env vars' });
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

/* ── VERIFY OTP ── */
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, code } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM otps WHERE email=$1', [email.toLowerCase()]);
    const record = rows[0];
    if (!record) return res.status(400).json({ error: 'No pending verification for this email' });
    if (new Date() > new Date(record.expires_at)) return res.status(400).json({ error: 'Code expired — request a new one' });
    if (record.code !== code) return res.status(400).json({ error: 'Incorrect code' });

    const joined = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const { rows: userRows } = await pool.query(
      `INSERT INTO users (username, email, password_hash, email_verified, joined)
       VALUES ($1,$2,$3,true,$4) RETURNING id, username, email, joined`,
      [record.username, email.toLowerCase(), record.password_hash, joined]
    );
    const user = userRows[0];
    await pool.query('DELETE FROM otps WHERE email=$1', [email.toLowerCase()]);

    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, joined: user.joined } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── LOGIN ── */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user) return res.status(400).json({ error: 'No account found with this email' });
    if (!user.email_verified) return res.status(400).json({ error: 'Email not verified — please register again' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Incorrect password' });

    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, joined: user.joined } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── RESEND OTP ── */
app.post('/api/auth/resend-otp', async (req, res) => {
  const { email } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM otps WHERE email=$1', [email.toLowerCase()]);
    if (!rows[0]) return res.status(400).json({ error: 'No pending verification found' });

    const code = otp6();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query('UPDATE otps SET code=$1, expires_at=$2 WHERE email=$3', [code, expires, email.toLowerCase()]);
    await sendOtpEmail(email, code);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── SITE CONFIG ── */
app.get('/api/config', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM site_config WHERE id=1');
    res.json(rows[0]?.data || {});
  } catch {
    res.json({});
  }
});

app.post('/api/config', async (req, res) => {
  const { data } = req.body;
  try {
    await pool.query(
      `INSERT INTO site_config (id, data) VALUES (1,$1)
       ON CONFLICT (id) DO UPDATE SET data=$1`,
      [data]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── USERS (admin) ── */
app.get('/api/users', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, email, joined, created_at FROM users ORDER BY created_at DESC');
    res.json(rows);
  } catch {
    res.json([]);
  }
});

/* ── HEALTH ── */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vouch backend on port ${PORT}`));
