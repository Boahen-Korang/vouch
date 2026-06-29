const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vouch-vouch4.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-vouch-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  /* secret check */
  const secret = process.env.VOUCH_SECRET;
  if (secret && req.headers['x-vouch-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { orderId, side, crypto, cryptoAmt, fiatAmt, fiatCurrency, username, payoutDetails, walletAddr } = req.body || {};

  /* validate orderId format */
  if (!orderId || !/^VCH-\d{4,}$/.test(orderId)) {
    return res.status(400).json({ error: 'Invalid order' });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const sideLabel = side === 'buy' ? 'BUY (user pays fiat, receives crypto)' : 'SELL (user sends crypto, receives fiat)';
  const detailsLine = side === 'sell'
    ? (payoutDetails?.type === 'momo'
        ? `MoMo: ${payoutDetails.network} · ${payoutDetails.number} · ${payoutDetails.name}`
        : `Bank: ${payoutDetails?.bankName} · ${payoutDetails?.account} · ${payoutDetails?.holder}`)
    : `Wallet: ${walletAddr || '—'}`;

  try {
    await transporter.sendMail({
      from: `"Vouch Orders" <${process.env.GMAIL_USER}>`,
      to: process.env.ADMIN_EMAIL || process.env.GMAIL_USER,
      subject: `New Order — ${orderId}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0A1610;color:#ECEEE7;padding:32px;border-radius:16px">
          <h2 style="margin:0 0 4px;color:#3FD98C">New Order Received</h2>
          <p style="color:#5E7568;font-size:13px;margin:0 0 24px">A customer has confirmed payment on Vouch.</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#90A89A;font-size:13px">Order ID</td><td style="padding:8px 0;font-family:monospace;font-size:13px">${orderId}</td></tr>
            <tr><td style="padding:8px 0;color:#90A89A;font-size:13px">Type</td><td style="padding:8px 0;font-size:13px">${sideLabel}</td></tr>
            <tr><td style="padding:8px 0;color:#90A89A;font-size:13px">Crypto</td><td style="padding:8px 0;font-size:13px">${cryptoAmt} ${crypto}</td></tr>
            <tr><td style="padding:8px 0;color:#90A89A;font-size:13px">Fiat value</td><td style="padding:8px 0;font-size:13px">${fiatCurrency || ''} ${fiatAmt}</td></tr>
            <tr><td style="padding:8px 0;color:#90A89A;font-size:13px">Customer</td><td style="padding:8px 0;font-size:13px">${username || 'Guest'}</td></tr>
            <tr><td style="padding:8px 0;color:#90A89A;font-size:13px">Details</td><td style="padding:8px 0;font-size:13px">${detailsLine}</td></tr>
          </table>
          <a href="https://vouch-vouch4.vercel.app/admin.html" style="display:inline-block;margin-top:24px;background:#3FD98C;color:#04130C;font-weight:700;padding:12px 24px;border-radius:10px;text-decoration:none">Open Admin Dashboard →</a>
        </div>`,
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
