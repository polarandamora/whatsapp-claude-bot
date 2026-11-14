// Bot de WhatsApp amb Claude, sobre Cloudflare Workers.
// Flux: Meta (webhook) -> aquest Worker -> Claude -> WhatsApp Cloud API.
// Alternativa per a proves: Twilio (sandbox de WhatsApp) -> /twilio -> Claude -> resposta TwiML.

import Anthropic from "@anthropic-ai/sdk";

const HISTORY_TTL_SECONDS = 24 * 60 * 60; // la conversa s'oblida després de 24 h sense missatges
const SEEN_IDS_KEPT = 20; // IDs de missatges recordats per evitar respondre dues vegades
const RESET_WORDS = ["/reset", "reset", "reinicia"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/twilio") {
      return handleTwilioRequest(request, env);
    }

    // 1) Verificació del webhook: Meta la fa una vegada, en desar la Callback URL.
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      if (mode === "subscribe" && token && token === env.VERIFY_TOKEN) {
        return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 2) Comprovar que la petició ve realment de Meta (signatura amb l'App Secret).
    const raw = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await isValidSignature(raw, signature, env.APP_SECRET))) {
      console.warn("Signatura invàlida: petició rebutjada");
      return new Response("Invalid signature", { status: 401 });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // 3) Respondre 200 de seguida (si no, Meta reintenta) i treballar en segon pla.
    ctx.waitUntil(
      handleWebhook(body, env).catch((err) => console.error("Error processant el webhook:", err))
    );
    return new Response("OK", { status: 200 });
  },
};

export async function handleWebhook(body, env) {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      // Els avisos d'estat (enviat, entregat, llegit) arriben a `statuses`, no a `messages`: s'ignoren.
      for (const message of value.messages ?? []) {
        await handleMessage(
          {
            id: message.id,
            from: message.from,
            isText: message.type === "text",
            text: message.text?.body ?? "",
          },
          env,
          (to, text) => sendWhatsAppText(env, to, text)
        );
      }
    }
  }
}

// --- Twilio (sandbox de WhatsApp) ---

async function handleTwilioRequest(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  const signature = request.headers.get("x-twilio-signature");
  if (!(await isValidTwilioSignature(request.url, params, signature, env.TWILIO_AUTH_TOKEN))) {
    console.warn("Signatura de Twilio invàlida: petició rebutjada");
    return new Response("Invalid signature", { status: 401 });
  }

  const message = {
    id: params.MessageSid,
    from: (params.From ?? "").replace(/\D/g, ""), // "whatsapp:+34600000000" -> mateix format que Meta
    isText: Number(params.NumMedia ?? 0) === 0 && Boolean(params.Body),
    text: params.Body ?? "",
  };

  // La resposta va dins de la mateixa resposta HTTP (TwiML): no cal l'API d'enviament ni plantilles.
  // Twilio espera fins a 15 s, prou per a Claude Haiku amb esforç baix.
  const replies = [];
  try {
    await handleMessage(message, env, async (_to, text) => {
      replies.push(text);
    });
  } catch (err) {
    console.error("Error processant el missatge de Twilio:", err);
  }

  const twiml = replies
    .map((text) => `<Message>${escapeXml(text.slice(0, 1600))}</Message>`) // límit de Twilio per missatge
    .join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${twiml}</Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Twilio signa: base64(HMAC-SHA1(auth token, URL + cada paràmetre ordenat com clau+valor)).
export async function isValidTwilioSignature(url, params, header, authToken) {
  if (!header || !authToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, header);
}

// --- Lògica comuna ---

// `message`: { id, from, isText, text }. `send(to, text)` envia la resposta pel canal corresponent.
async function handleMessage(message, env, send) {
  const from = message.from; // número de l'usuari, en format internacional sense "+"
  const key = `conv:${from}`;
  const state = (await env.CONVERSES.get(key, "json")) ?? { history: [], seen: [] };

  // Evitar respostes duplicades si Meta reenvia el mateix missatge.
  if (state.seen.includes(message.id)) {
    console.log(`Missatge ${message.id} ja processat, s'ignora`);
    return;
  }
  state.seen = [...state.seen, message.id].slice(-SEEN_IDS_KEPT);

  if (!message.isText) {
    await send(from, "De moment només puc llegir missatges de text. Me'l pots escriure? 🙂");
    await saveState(env, key, state);
    return;
  }

  const text = message.text.trim();
  if (!text) return;

  if (RESET_WORDS.includes(text.toLowerCase())) {
    state.history = [];
    await send(from, "Fet! He oblidat la conversa anterior. En què et puc ajudar?");
    await saveState(env, key, state);
    return;
  }

  const messages = [...state.history, { role: "user", content: text }];

  let reply;
  try {
    reply = await askClaude(env, messages);
  } catch (err) {
    console.error("Error cridant Claude:", err);
    await send(from, "Ara mateix no puc respondre. Torna-ho a provar d'aquí a una estona, si us plau.");
    await saveState(env, key, state); // es desa l'ID per no reintentar en bucle, però no l'historial
    return;
  }

  await send(from, reply);

  // Guardar els últims torns (parells usuari/assistent) perquè el bot recordi el context.
  const maxMessages = Math.max(0, Number(env.HISTORY_TURNS ?? 10)) * 2;
  state.history = [...messages, { role: "assistant", content: reply }].slice(-maxMessages);
  await saveState(env, key, state);
}

async function askClaude(env, messages) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: env.MODEL ?? "claude-haiku-5-5",
    max_tokens: 1024,
    // Xat senzill: sense raonament intern i esforç baix = respostes ràpides i barates.
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: env.SYSTEM_PROMPT,
    messages,
  });

  if (response.stop_reason === "refusal") {
    return "Ho sento, no puc ajudar-te amb això. Un agent de l'equip es posarà en contacte amb tu.";
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return text || "Perdona, no t'he entès. Ho pots dir d'una altra manera?";
}

async function sendWhatsAppText(env, to, body) {
  const version = env.GRAPH_VERSION ?? "v23.0";
  const res = await fetch(`https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: body.slice(0, 4096) }, // límit de WhatsApp per missatge de text
    }),
  });
  if (!res.ok) {
    // Error típic: 401 = token caducat; 131030 = número no afegit a la llista de proves.
    console.error(`Error enviant a WhatsApp (${res.status}):`, await res.text());
  }
}

async function saveState(env, key, state) {
  await env.CONVERSES.put(key, JSON.stringify(state), { expirationTtl: HISTORY_TTL_SECONDS });
}

export async function isValidSignature(raw, header, secret) {
  if (!header || !secret || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, header);
}

// Comparació de temps constant
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
