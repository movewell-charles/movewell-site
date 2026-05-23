// netlify/functions/subscribe.js — v2
// ─────────────────────────────────────────────────────────────
// Variables d'environnement Netlify à configurer :
//   GOOGLE_SERVICE_ACCOUNT_KEY   → JSON du compte de service Google
//   GOOGLE_SHEET_ID              → ID de la Google Sheet (URL)
//   BREVO_API_KEY                → Clé API Brevo
//   BREVO_LIST_ID                → ID de la liste (ex: 3)
//   BREVO_TEMPLATE_ID            → ID du template email (ex: 12)
//   PDF_URL                      → URL publique du guide PDF
// ─────────────────────────────────────────────────────────────

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT }               = require('google-auth-library');

exports.handler = async function (event) {

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
  }

  // Parse body
  let name, email, phone;
  try {
    ({ name, email, phone } = JSON.parse(event.body));
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Email invalide');
    }
  } catch (e) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }

  // Lancer les deux actions en parallèle
  const results = await Promise.allSettled([
    writeToGoogleSheets(name, email, phone),
    addToBrevoAndSendGuide(name, email, phone),
  ]);

  const errors = results.filter(r => r.status === 'rejected');
  // Log ALL errors for debugging
  errors.forEach((e, i) => console.error('Erreur operation', i, ':', e.reason?.message, e.reason?.stack));
  if (errors.length === 2) {
    console.error('Double échec:', errors.map(e => e.reason?.message));
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Erreur serveur' }) };
  }

  return {
    statusCode: 200,
    headers: cors(),
    body: JSON.stringify({ success: true }),
  };
};

// ── Écriture dans Google Sheets ─────────────────────────────
async function writeToGoogleSheets(name, email, phone) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new JWT({
    email: credentials.client_email,
    key:   credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  console.log('Sheets: doc loaded, title=', doc.title, 'sheets=', Object.keys(doc.sheetsByTitle));
  const sheet = doc.sheetsByTitle['📋 Leads'] || doc.sheetsByIndex[0];
  console.log('Sheets: using sheet title=', sheet.title, 'id=', sheet.sheetId);
  await sheet.loadHeaderRow();
  console.log('Sheets: headers loaded=', sheet.headerValues);

  const now = new Date().toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  await sheet.addRow({
    'Date inscription': now,
    'Prénom':           name  || '',
    'E-mail':           email,
    'Téléphone':        phone || '',
    'Source':           'Popup movewell.fr',
    'Statut':           'Nouveau',
    'Lead Score':       phone ? 5 : 3,
    'Guide téléchargé': 'Oui',
    'NL ouverte':       'Non',
    'Répondu':          'Non',
    'RDV pris':         'Non',
    'Client MoveWell':  'Non',
    'Notes':            phone ? 'A laissé son téléphone → à rappeler' : '',
  });
}

// ── Brevo : contact + envoi guide ───────────────────────────
async function addToBrevoAndSendGuide(name, email, phone) {
  const headers = {
    'Content-Type': 'application/json',
    'api-key': process.env.BREVO_API_KEY,
  };

  // 1. Créer / mettre à jour le contact Brevo
  const contactPayload = {
    email,
    attributes: {
      PRENOM: name  || '',
      SMS:    phone || '',
    },
    listIds: [Number(process.env.BREVO_LIST_ID)],
    updateEnabled: true,
  };

  await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers,
    body: JSON.stringify(contactPayload),
  });

  // 2. Envoyer le guide par email transactionnel
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      to: [{ email, name: name || email }],
      templateId: Number(process.env.BREVO_TEMPLATE_ID),
      params: {
        PRENOM:  name  || 'toi',
        PDF_URL: process.env.PDF_URL,
        PHONE:   phone || '',
      },
      sender: {
        name:  'Charles Coissac · Move Well',
        email: 'charles@movewell.fr',
      },
      replyTo: {
        email: 'charles@movewell.fr',
        name:  'Charles Coissac',
      },
    }),
  });

  // 3. Si téléphone renseigné : notification à Charles
  if (phone) {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to: [{ email: 'charles@movewell.fr', name: 'Charles Coissac' }],
        sender: { name: 'Move Well Notifications', email: 'charles@movewell.fr' },
        subject: `🔥 Nouveau lead chaud — ${name || email} (${phone})`,
        htmlContent: `
          <p>Un visiteur a laissé son numéro de téléphone.</p>
          <table>
            <tr><td><strong>Prénom :</strong></td><td>${name || 'Non renseigné'}</td></tr>
            <tr><td><strong>Email :</strong></td><td>${email}</td></tr>
            <tr><td><strong>Téléphone :</strong></td><td>${phone}</td></tr>
          </table>
          <p>→ <a href="https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}">Voir dans le CRM</a></p>
        `,
      }),
    });
  }
}

// ── CORS ────────────────────────────────────────────────────
function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}
