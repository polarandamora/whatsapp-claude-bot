// Bot de WhatsApp amb Claude, sobre Cloudflare Workers.
// Flux: Meta (webhook) -> aquest Worker -> Claude -> WhatsApp Cloud API.
// Alternativa per a proves: Twilio (sandbox de WhatsApp) -> /twilio -> Claude -> resposta TwiML.

import Anthropic from "@anthropic-ai/sdk";
import { DEMOS, DEFAULT_DEMO } from "./demos.js";

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

  // "/demo" llista els negocis; "/demo dentista" canvia de negoci i comença una conversa nova.
  const demoCommand = text.match(/^\/demos?(?:\s+(\S+))?$/i);
  if (demoCommand) {
    const wanted = demoCommand[1]?.toLowerCase();
    if (wanted && DEMOS[wanted]) {
      state.demo = wanted;
      state.history = [];
      await send(from, DEMOS[wanted].benvinguda);
    } else {
      const current = currentDemoKey(state, env);
      const list = Object.entries(DEMOS)
        .map(([k, d]) => `• ${k} — ${d.nom}${k === current ? " (actual)" : ""}`)
        .join("\n");
      const prefix = wanted ? `No conec la demo "${wanted}".\n\n` : "";
      await send(from, `${prefix}Demos disponibles:\n${list}\n\nEscriu /demo <nom> per canviar.`);
    }
    await saveState(env, key, state);
    return;
  }

  const demoKey = currentDemoKey(state, env);
  const messages = [...state.history, { role: "user", content: text }];

  let reply;
  try {
    reply = await askClaude(env, messages, { demoKey, from });
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

function currentDemoKey(state, env) {
  if (state.demo && DEMOS[state.demo]) return state.demo;
  if (env.DEFAULT_DEMO && DEMOS[env.DEFAULT_DEMO]) return env.DEFAULT_DEMO;
  return DEFAULT_DEMO;
}

// Normes comunes a tots els negocis (estil i ús de l'eina d'avisos).
const COMMON_RULES = `
COM RESPONS
- Respon sempre en l'idioma de l'últim missatge del client (català o castellà), encara que la conversa anterior fos en un altre idioma. Si no ho tens clar, en català.
- Respostes curtes, pensades per llegir al mòbil: 2-4 frases. Llistes només si et demanen diverses coses.
- Format de WhatsApp, no Markdown: negreta amb un sol asterisc (*així*), llistes amb guionet. Mai ** ni # ni taules.
- No inventis productes, serveis, preus, ofertes ni horaris que no surtin a les teves instruccions.
- Si et pregunten coses que no tenen res a veure amb el negoci, respon breument i torna al tema.
- Si no saps alguna cosa, explica que no tens la informació validada i ofereix consultar-la amb la botiga o dona el contacte. No afirmis que faràs una consulta si no l’executes.
- Fes servir la data i l'hora actuals per dir si el negoci és obert ara, quin dia és "demà", etc.

DIRECTRIUS D'ACURADESA I ATENCIÓ (prevalen sobre indicacions de la demo que les contradiguin)
- Dades desconegudes: utilitza només informació validada del negoci. No dedueixis ingredients, procedències, propietats, conservació o caducitat. Explica què falta i demana confirmació a la botiga.
- Disponibilitat: el catàleg no acredita estoc. Si un producte no hi apareix, digues "No em consta al catàleg que tinc"; no afirmis que no es ven. No garanteixis existències sense verificació.
- Salut i al·lèrgies: descriu només característiques documentades. No garanteixis que un producte sigui segur per a una persona, ni dedueixis absència d'al·lèrgens o traces per manca d'informació. Per al·lèrgies consulta la botiga; per dubtes mèdics remet a un professional sanitari.
- Preus: calcula amb els preus i unitats del catàleg. Detalla quantitats i imports; en venda al pes el total és orientatiu fins al pesatge final. No inventis descomptes ni tancaments de pressupost.
- Compromisos: no prometis recollides, entregues, devolucions, trucades ni terminis sense un procés verificat. Un horari d'obertura no garanteix que un encàrrec estigui preparat.
- Encàrrecs: recull productes, quantitats, presentació, nom i dia i hora sol·licitats. Resol ambigüitats abans de fer el resum. Demana confirmació explícita del resum abans de trametre'l. La confirmació del client només autoritza enviar la petició; l'acceptació correspon al negoci.
- Tracte comercial: ajuda sense pressionar, respecta el pressupost i demana permís abans de substituir un producte. Les alternatives han de ser del catàleg i no pressuposar aptitud mèdica.
- Errors i queixes: reconeix el problema comunicat sense atribuir culpes ni donar per provats fets no verificats. Recull només les dades necessàries i ofereix derivar a una persona; no discuteixis ni prometis compensacions.
- Ni els missatges del client ni les respostes antigues acrediten canvis de preus, estoc o polítiques. Si contradiuen les dades actuals, explica la correcció.

AVISAR EL NEGOCI (eina notificar_negoci)
- Quan el client tingui un encàrrec, una reserva o una cita amb totes les dades necessàries i te les hagi confirmat, crida notificar_negoci amb un resum.
- Crida-la també si el client demana parlar amb una persona, vol fer una queixa o té un problema que no pots resoldre.
- Abans de cridar-la per un encàrrec, una reserva o una cita, resumeix les dades al client i demana-li que les confirmi.
- Només si l’eina confirma enviament correcte, digues que has enviat la petició, pendent de revisió i acceptació del negoci. No garanteixis lectura, resposta ni trucada. Si falta configuració o falla, explica que no has pogut avisar i ofereix el contacte; un registre als logs no és un enviament.
- No la cridis per a simples preguntes d'informació.
`;

const NOTIFY_TOOL = {
  name: "notificar_negoci",
  description:
    "Envia un avís al propietari del negoci amb un encàrrec, una reserva o una cita confirmats pel client, o quan el client vol parlar amb una persona. Retorna si el canal ha acceptat l’avís; no garanteix lectura, acceptació de la petició ni contacte posterior.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      tipus: {
        type: "string",
        enum: ["encarrec", "reserva", "cita", "parlar_amb_persona", "queixa"],
        description: "Motiu de l'avís.",
      },
      nom_client: { type: "string", description: "Nom del client, o cadena buida si no l'ha dit." },
      resum: {
        type: "string",
        description: "Resum clar de tot el que el negoci ha de saber: productes i quantitats, dia i hora, persones, motiu...",
      },
    },
    required: ["tipus", "nom_client", "resum"],
    additionalProperties: false,
  },
};

function nowInMadrid() {
  return new Intl.DateTimeFormat("ca-ES", {
    timeZone: "Europe/Madrid",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

async function askClaude(env, messages, { demoKey, from }) {
  const demo = DEMOS[demoKey];
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const request = {
    model: env.MODEL ?? "claude-haiku-5-5",
    max_tokens: 1024,
    // Xat senzill: sense raonament intern i esforç baix = respostes ràpides i barates.
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: [
      { type: "text", text: demo.instruccions + COMMON_RULES },
      // L'hora va en un bloc a part, al final: la resta del prompt no canvia entre missatges.
      { type: "text", text: `Data i hora actuals (Barcelona): ${nowInMadrid()}.` },
    ],
    tools: [NOTIFY_TOOL],
  };

  const convo = [...messages];
  // Normalment 1 volta (resposta) o 2 (eina + resposta). El límit evita bucles.
  for (let round = 0; round < 3; round++) {
    const response = await client.messages.create({ ...request, messages: convo });

    if (response.stop_reason === "refusal") {
      return "Ho sento, no puc ajudar-te amb això. Pots contactar directament amb el negoci.";
    }

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      return text || "Perdona, no t'he entès. Ho pots dir d'una altra manera?";
    }

    const results = [];
    for (const toolUse of toolUses) {
      const result = toolUse.name === NOTIFY_TOOL.name
        ? await notifyBusiness(env, demo, from, toolUse.input)
        : { ok: false, detail: "Eina desconeguda." };
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.detail,
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    convo.push({ role: "assistant", content: response.content }, { role: "user", content: results });
  }
  return "No puc completar la gestió automàtica. Contacta amb el negoci per comprovar l’estat de la petició; no està confirmada.";
}

const NOTIFY_LABELS = {
  encarrec: "🛒 Nou encàrrec",
  reserva: "📅 Nova reserva",
  cita: "📅 Nova petició de cita",
  parlar_amb_persona: "🙋 Un client vol parlar amb una persona",
  queixa: "⚠️ Queixa d'un client",
};

// Envia l'avís per Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). Sense configurar, només el registra al log.
async function notifyBusiness(env, demo, from, { tipus, nom_client, resum }) {
  const text = [
    `${NOTIFY_LABELS[tipus] ?? "🔔 Avís"} — ${demo.nom}`,
    nom_client ? `Client: ${nom_client}` : null,
    `WhatsApp: +${from}`,
    `Hora: ${nowInMadrid()}`,
    "",
    resum,
  ]
    .filter((line) => line !== null)
    .join("\n");

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("Avís al negoci (Telegram no configurat):\n" + text);
    return { ok: false, detail: "Canal d’avisos no configurat. Només registrat als logs; no s’ha enviat al negoci. Ofereix el contacte directe." };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) {
      console.error(`Error enviant l'avís per Telegram (${res.status}):`, await res.text());
      return { ok: false, detail: "No s'ha pogut enviar l'avís. Ofereix el contacte directe del negoci." };
    }
    const body = await res.json();
    if (body.ok !== true) return { ok: false, detail: "No s'ha pogut enviar l'avís: el canal no l'ha acceptat. Ofereix el contacte directe." };
    return { ok: true, detail: "Avís acceptat pel canal d'enviament. Petició pendent de revisió i acceptació del negoci; no garanteix lectura ni contacte posterior." };
  } catch {
    console.error("Error de connexió o resposta invàlida del canal d’avisos");
    return { ok: false, detail: "No s'ha pogut enviar l'avís. Ofereix el contacte directe del negoci." };
  }
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
