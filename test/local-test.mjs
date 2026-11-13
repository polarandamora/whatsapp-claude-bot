// Prova local sense xarxa: simula Meta, Claude i el KV de Cloudflare.
import crypto from "node:crypto";
import worker from "../src/index.js";

const env = {
  ANTHROPIC_API_KEY: "sk-ant-test", WHATSAPP_TOKEN: "wa-test", PHONE_NUMBER_ID: "111",
  APP_SECRET: "secret", VERIFY_TOKEN: "vt", MODEL: "claude-haiku-5-5", GRAPH_VERSION: "v23.0",
  HISTORY_TURNS: "2", SYSTEM_PROMPT: "Ets un bot de prova.",
};
const store = new Map();
env.CONVERSES = {
  async get(k, t) { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
};

const sent = [], claudeCalls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const bodyText = init.body ?? (input.text ? await input.text() : "");
  if (url.includes("api.anthropic.com")) {
    const b = JSON.parse(bodyText); claudeCalls.push(b);
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: b.model,
      content: [{ type: "text", text: `Resposta ${claudeCalls.length}` }], stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
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
console.log(fails ? `\n${fails} proves fallides` : "\nTotes les proves han passat");
process.exit(fails ? 1 : 0);
