// Prova local sense xarxa: simula Meta, Claude i el KV de Cloudflare.
import crypto from "node:crypto";
import worker from "../src/index.js";

const env = {
  ANTHROPIC_API_KEY: "sk-ant-test", WHATSAPP_TOKEN: "wa-test", PHONE_NUMBER_ID: "111",
  APP_SECRET: "secret", VERIFY_TOKEN: "vt", MODEL: "claude-haiku-5-5", GRAPH_VERSION: "v23.0",
  HISTORY_TURNS: "2", SYSTEM_PROMPT: "Ets un bot de prova.",
  TWILIO_AUTH_TOKEN: "tw-secret",
};
const store = new Map();
env.CONVERSES = {
  async get(k, t) { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
};

const sent = [], claudeCalls = [], twilioSent = [], telegramSent = [];
let telegramMode = "ok";
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const bodyText = init.body ?? (input.text ? await input.text() : "");
  if (url.includes("api.anthropic.com")) {
    const b = JSON.parse(bodyText); claudeCalls.push(b);
    const last = b.messages.at(-1);
    if (typeof last.content === "string" && last.content.includes("CONFIRMO")) {
      return new Response(JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: b.model,
        content: [{ type: "tool_use", id: "tu_1", name: "notificar_negoci",
          input: { tipus: "encarrec", nom_client: "Anna", resum: "2 fuets per divendres a les 18h" } }],
        stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: b.model,
      content: [{ type: "text", text: `Resposta ${claudeCalls.length}` }], stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.telegram.org")) { telegramSent.push({ url, body: JSON.parse(bodyText) }); if (telegramMode === "network") throw new Error("Network failure"); return new Response(JSON.stringify({ ok: telegramMode === "ok" }), { status: telegramMode === "http" ? 500 : 200 }); }
  if (url.includes("api.twilio.com")) { twilioSent.push({ url, auth: init.headers.Authorization, body: Object.fromEntries(new URLSearchParams(bodyText)) }); return new Response("{}", { status: 201 }); }
  if (url.includes("graph.facebook.com")) { sent.push({ url, body: JSON.parse(bodyText) }); return new Response("{}", { status: 200 }); }
  throw new Error("URL inesperada " + url);
};

const sign = (raw, s = env.APP_SECRET) => "sha256=" + crypto.createHmac("sha256", s).update(raw).digest("hex");
async function post(payload, sig) {
  const raw = JSON.stringify(payload); const waits = [];
  const res = await worker.fetch(new Request("https://bot.example/", { method: "POST", body: raw,
    headers: { "x-hub-signature-256": sig ?? sign(raw) } }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits); return res;
}
const msg = (id, text, type = "text") => ({ entry: [{ changes: [{ value: { messages: [
  type === "text" ? { id, from: "34600000000", type, text: { body: text } } : { id, from: "34600000000", type } ] } }] }] });
const status = { entry: [{ changes: [{ value: { statuses: [{ id: "x", status: "read" }] } }] }] };
let fails = 0; const check = (c, m) => { console.log((c ? "OK   " : "FAIL ") + m); if (!c) fails++; };

let r = await worker.fetch(new Request("https://bot.example/?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=123"), env, {});
check(r.status === 200 && (await r.text()) === "123", "verificació GET retorna el challenge");
r = await worker.fetch(new Request("https://bot.example/?hub.mode=subscribe&hub.verify_token=dolent&hub.challenge=1"), env, {});
check(r.status === 403, "verificació GET amb token incorrecte = 403");
r = await post(msg("a", "hola"), "sha256=dolenta");
check(r.status === 401 && sent.length === 0, "signatura falsa rebutjada");
r = await post(status);
check(r.status === 200 && claudeCalls.length === 0 && sent.length === 0, "avisos d'estat ignorats");
await post(msg("m1", "Hola"));
check(sent.length === 1 && sent[0].body.text.body === "Resposta 1" && sent[0].body.to === "34600000000", "resposta enviada a WhatsApp");
check(claudeCalls[0].model === "claude-haiku-5-5" && claudeCalls[0].thinking.type === "disabled" && claudeCalls[0].system, "crida a Claude amb model, thinking i system");
await post(msg("m1", "Hola"));
check(sent.length === 1 && claudeCalls.length === 1, "missatge duplicat ignorat");
await post(msg("m2", "Què més?"));
check(claudeCalls[1].messages.length === 3 && claudeCalls[1].messages[1].content === "Resposta 1", "historial enviat a Claude");
await post(msg("m3", "I ara?")); await post(msg("m4", "Últim"));
const last = claudeCalls.at(-1).messages;
check(last.length === 5 && last[0].role === "user", "historial retallat (2 torns) i comença per user");
await post(msg("m5", "", "audio"));
check(sent.at(-1).body.text.body.includes("només puc llegir"), "àudio: avisa que només llegeix text");
const n = claudeCalls.length; await post(msg("m6", "reset"));
check(claudeCalls.length === n && JSON.parse(store.get("conv:34600000000")).history.length === 0, "reset esborra l'historial");

// --- Twilio ---
const TW_URL = "https://bot.example/twilio";
const twSign = (params, token = env.TWILIO_AUTH_TOKEN) => crypto.createHmac("sha1", token)
  .update(TW_URL + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");
async function twPost(params, sig) {
  const waits = [];
  const res = await worker.fetch(new Request(TW_URL, { method: "POST", body: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig ?? twSign(params) } }),
    env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits); return res;
}
const twMsg = (sid, body, numMedia = "0") => ({ MessageSid: sid, From: "whatsapp:+34611111111", To: "whatsapp:+14155238886", Body: body, NumMedia: numMedia });

r = await twPost(twMsg("SM1", "Hola"), "signatura-dolenta");
check(r.status === 401 && twilioSent.length === 0, "Twilio: signatura falsa rebutjada");
const c0 = claudeCalls.length;
r = await twPost(twMsg("SM1", "Hola Twilio"));
let xml = await r.text();
check(r.status === 200 && xml.includes(`<Message>Resposta ${c0 + 1}</Message>`), "Twilio: resposta de Claude dins del TwiML");
check(twilioSent.length === 0, "Twilio: no fa servir l'API d'enviament");
check(claudeCalls.length === c0 + 1 && claudeCalls.at(-1).messages.at(-1).content === "Hola Twilio", "Twilio: missatge passat a Claude");
check(store.has("conv:34611111111"), "Twilio: conversa desada amb el número en dígits");
r = await twPost(twMsg("SM1", "Hola Twilio"));
check(!(await r.text()).includes("<Message>") && claudeCalls.length === c0 + 1, "Twilio: missatge duplicat ignorat");
r = await twPost(twMsg("SM2", "", "1"));
check((await r.text()).includes("només puc llegir"), "Twilio: imatge/àudio avisa que només llegeix text");
r = await worker.fetch(new Request(TW_URL), env, {});
check(r.status === 405, "Twilio: GET = 405");

// --- Data i hora, demos i avisos ---
const sys = claudeCalls[0].system;
check(Array.isArray(sys) && sys[0].text.includes("Tot Bodebón") && sys[0].text.includes("notificar_negoci"), "system: instruccions de la demo per defecte + normes comunes");
check(/Data i hora actuals \(Barcelona\): .*20\d\d/.test(sys[1].text), "system: inclou la data i l'hora actuals");
check(claudeCalls[0].tools?.[0]?.name === "notificar_negoci" && claudeCalls[0].tools[0].strict === true, "eina notificar_negoci declarada");

const nc = claudeCalls.length;
await post(msg("d1", "/demo"));
check(claudeCalls.length === nc && sent.at(-1).body.text.body.includes("dentista") && sent.at(-1).body.text.body.includes("xarcuteria — Xarcuteria Tot Bodebón (actual)"), "/demo llista les demos i marca l'actual");
await post(msg("d2", "/demo dentista"));
check(claudeCalls.length === nc && sent.at(-1).body.text.body.includes("Clínica Dental Somriure"), "/demo dentista envia la benvinguda");
check(JSON.parse(store.get("conv:34600000000")).history.length === 0, "/demo dentista comença una conversa nova");
await post(msg("d3", "Voldria una neteja"));
check(claudeCalls.at(-1).system[0].text.includes("Somriure") && !claudeCalls.at(-1).system[0].text.includes("Tot Bodebón"), "després de /demo dentista, Claude rep les instruccions del dentista");
await post(msg("d4", "/demo inventat"));
check(sent.at(-1).body.text.body.includes('No conec la demo "inventat"'), "/demo amb un nom desconegut avisa");
await post(msg("d5", "/DEMO Xarcuteria"));
check(sent.at(-1).body.text.body.includes("Tot Bodebón"), "/demo no distingeix majúscules");

// Avís sense Telegram configurat: no falla i la resposta final arriba al client.
const before = claudeCalls.length;
await post(msg("n1", "Sí, CONFIRMO l'encàrrec"));
const followUp = claudeCalls.at(-1).messages;
check(claudeCalls.length === before + 2 && followUp.at(-1).content[0].type === "tool_result" && followUp.at(-1).content[0].is_error === true && followUp.at(-1).content[0].content.includes("no configurat"), "eina: s'executa i Claude rep el resultat");
check(sent.at(-1).body.text.body === `Resposta ${before + 2}`, "eina: el client rep la resposta final de Claude");
check(telegramSent.length === 0, "eina: sense Telegram configurat no s'envia res");
check(JSON.parse(store.get("conv:34600000000")).history.every((m) => typeof m.content === "string"), "eina: l'historial només desa text");

// Avís amb Telegram configurat.
env.TELEGRAM_BOT_TOKEN = "tg-token"; env.TELEGRAM_CHAT_ID = "999";
await post(msg("n2", "CONFIRMO, gràcies"));
const tg = telegramSent.at(-1);
check(tg && tg.url.includes("/bottg-token/sendMessage") && tg.body.chat_id === "999", "Telegram: avís enviat al xat configurat");
check(tg.body.text.includes("Nou encàrrec") && tg.body.text.includes("Tot Bodebón") && tg.body.text.includes("Anna")
  && tg.body.text.includes("+34600000000") && tg.body.text.includes("2 fuets"), "Telegram: l'avís porta tipus, negoci, client, telèfon i resum");
const okResult = claudeCalls.at(-1).messages.at(-1).content[0];
check(okResult.content.includes("google.com/search?q=Xarcuteria+Tot+Bodeb"), "ressenya: Claude rep l'enllaç quan l'encàrrec s'ha enviat");
check(sent.at(-1).body.text.body.includes("ressenya a Google: https://www.google.com/search?q=Xarcuteria+Tot+Bodeb"), "ressenya: si Claude no posa l'enllaç, el codi l'afegeix");
check(!sent.find((m) => m.body.text.body === `Resposta ${before + 2}` && m.body.text.body.includes("google.com")), "ressenya: sense Telegram (avís no enviat) no es demana ressenya");

for (const mode of ["http", "api", "network"]) {
  telegramMode = mode;
  await post(msg(`failure-${mode}`, "CONFIRMO"));
  const result = claudeCalls.at(-1).messages.at(-1).content[0];
  check(result.is_error === true && result.content.includes("No s'ha pogut"), `Telegram: ${mode} no es declara enviat`);
  check(!sent.at(-1).body.text.body.includes("et contactaran"), `Telegram: ${mode} no promet contacte`);
  check(!sent.at(-1).body.text.body.includes("google.com"), `Telegram: ${mode} no demana ressenya`);
}

console.log(fails ? `\n${fails} proves fallides` : "\nTotes les proves han passat");
process.exit(fails ? 1 : 0);
