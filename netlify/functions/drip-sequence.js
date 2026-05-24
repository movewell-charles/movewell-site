// netlify/functions/drip-sequence.js
// ─────────────────────────────────────────────────────────────
// Netlify Scheduled Function — tourne chaque matin à 8h (Paris)
// Lit le Google Sheet, envoie le bon email Brevo selon J+1/J+4/J+7
//
// Schedule défini dans netlify.toml :
//   [functions."drip-sequence"]
//   schedule = "0 6 * * *"   (6h UTC = 8h Paris)
// ─────────────────────────────────────────────────────────────

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT }               = require('google-auth-library');

// Templates Brevo par jour
const SEQUENCE = [
  { day: 1, templateId: 4 },
  { day: 4, templateId: 5 },
  { day: 7, templateId: 6 },
];

exports.handler = async function () {
  console.log('drip-sequence: démarrage', new Date().toISOString());

  try {
    const rows = await getSheetRows();
    console.log(`drip-sequence: ${rows.length} contacts à vérifier`);

    const today = startOfDay(new Date());
    let sent = 0;

    for (const row of rows) {
      const email  = row.get('E-mail');
      const prenom = row.get('Prénom') || '';
      const phone  = row.get('Téléphone') || '';
      const dateStr = row.get('Date inscription');
      if (!email || !dateStr) continue;

      const signupDate = parseDate(dateStr);
      if (!signupDate) continue;

      const daysSince = Math.round((today - signupDate) / 86400000);

      for (const step of SEQUENCE) {
        if (daysSince === step.day) {
          const ok = await sendBrevoTemplate(email, prenom, phone, step.templateId);
          if (ok) {
            sent++;
            console.log(`drip-sequence: J+${step.day} envoyé à ${email}`);
          }
        }
      }
    }

    console.log(`drip-sequence: terminé — ${sent} emails envoyés`);
    return { statusCode: 200, body: JSON.stringify({ sent }) };

  } catch (err) {
    console.error('drip-sequence: erreur', err.message);
    return { statusCode: 500, body: err.message };
  }
};

// ── Google Sheets ────────────────────────────────────────────
async function getSheetRows() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new JWT({
    email:  credentials.client_email,
    key:    credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['📋 Leads'] || doc.sheetsByIndex[0];
  await sheet.loadHeaderRow();
  return sheet.getRows();
}

// ── Brevo transactionnel ─────────────────────────────────────
async function sendBrevoTemplate(email, prenom, phone, templateId) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      to: [{ email, name: prenom || email }],
      templateId,
      params: { PRENOM: prenom || 'toi', PHONE: phone },
      sender:  { name: 'Charles · Move Well', email: 'charles@movewell.fr' },
      replyTo: { email: 'charles@movewell.fr', name: 'Charles Coissac' },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Brevo error ${res.status} template ${templateId} → ${email}:`, err);
    return false;
  }
  return true;
}

// ── Helpers date ─────────────────────────────────────────────
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function parseDate(str) {
  // Format stocké : "23/05/2026 à 14:30" ou "23/05/2026, 14:30" ou "23/05/2026 14:30"
  if (!str) return null;
  const match = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  return startOfDay(new Date(parseInt(year), parseInt(month) - 1, parseInt(day)));
}
