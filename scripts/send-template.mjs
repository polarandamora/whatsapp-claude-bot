// Envia una plantilla de WhatsApp a un o diversos números a través de Twilio.
//
// Credencials: fitxer .dev.vars (exclòs de git) amb
//   TWILIO_ACCOUNT_SID=AC...
//   TWILIO_AUTH_TOKEN=...
//
// Ús:
//   npm run plantilla -- --list
//       Llista les plantilles disponibles (ContentSid, nom i text).
//   npm run plantilla -- <ContentSid> '<variables JSON>' +34600000000 [+34611111111 ...]
//       Exemple: npm run plantilla -- HX123... '{"1":"divendres","2":"18:00"}' +34600000000
//
// Al sandbox només arriba als números que hagin enviat "join ..." en les últimes 72 h.

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_WHATSAPP_FROM ?? "whatsapp:+14155238886"; // número del sandbox

if (!SID || !TOKEN) {
  console.error("Falten TWILIO_ACCOUNT_SID i TWILIO_AUTH_TOKEN al fitxer .dev.vars");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");
const args = process.argv.slice(2);

if (args[0] === "--list") {
  await listTemplates();
} else if (args.length >= 3) {
  const [contentSid, variables, ...numbers] = args;
  try {
    JSON.parse(variables);
  } catch {
    console.error(`Les variables han de ser JSON, per exemple '{"1":"divendres"}'. Rebut: ${variables}`);
    process.exit(1);
  }
  let failed = 0;
  for (const number of numbers) {
    if (!(await sendTemplate(contentSid, variables, number))) failed++;
  }
  process.exit(failed ? 1 : 0);
} else {
  console.error("Ús: npm run plantilla -- --list");
  console.error("     npm run plantilla -- <ContentSid> '<variables JSON>' +34600000000 [+34...]");
  process.exit(1);
}

async function listTemplates() {
  let url = "https://content.twilio.com/v1/Content?PageSize=50";
  let count = 0;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: auth } });
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error llistant plantilles (${res.status}):`, data.message ?? data);
      process.exit(1);
    }
    for (const c of data.contents ?? []) {
      count++;
      const body = Object.values(c.types ?? {})
        .map((t) => t.body)
        .find(Boolean);
      console.log(`${c.sid}  ${c.friendly_name}`);
      if (body) console.log(`    "${body}"`);
      if (c.variables && Object.keys(c.variables).length) {
        console.log(`    variables d'exemple: ${JSON.stringify(c.variables)}`);
      }
    }
    url = data.meta?.next_page_url ?? null;
  }
  if (!count) console.log("No hi ha cap plantilla al compte.");
}

async function sendTemplate(contentSid, variables, number) {
  const to = "whatsapp:" + (number.startsWith("+") ? number : `+${number}`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: FROM, To: to, ContentSid: contentSid, ContentVariables: variables }),
  });
  const data = await res.json();
  if (res.ok) {
    console.log(`OK    ${to}  (${data.sid}, estat: ${data.status})`);
    return true;
  }
  // 63015 = el número no s'ha unit al sandbox; 21608/21606 = límits del compte de prova.
  console.error(`ERROR ${to}  (${data.code}): ${data.message}`);
  return false;
}
