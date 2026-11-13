# Bot de WhatsApp amb Claude (Cloudflare Workers)

Rep missatges de WhatsApp (Cloud API de Meta), els respon amb Claude i recorda les últimes converses. Sense Make ni servidors.

- `src/index.js`: tot el bot
- `wrangler.toml`: configuració (model, instruccions del bot, KV)
- `test/local-test.mjs`: proves locals sense xarxa (`npm test`)

Passos complets a la guia: [`docs/guia-whatsapp-claude.html`](docs/guia-whatsapp-claude.html) (obriu-la al navegador). Resum:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CONVERSES   # copieu l'id a wrangler.toml
npx wrangler secret put ANTHROPIC_API_KEY    # i també WHATSAPP_TOKEN, PHONE_NUMBER_ID, APP_SECRET, VERIFY_TOKEN
npx wrangler deploy
```

Logs en directe: `npm run logs`. Per esborrar la memòria d'una conversa, l'usuari escriu `reset`.
