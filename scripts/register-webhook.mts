// One-off operator script. Usage:
//   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/register-webhook.mts https://polski-bot.<account>.workers.dev
// Sets the webhook with the secret header and allowed_updates (spec §7) and registers the command menu.
const url = process.argv[2];
const token = process.env['TELEGRAM_BOT_TOKEN'];
const secret = process.env['TELEGRAM_WEBHOOK_SECRET'];
if (!url || !token || !secret) {
  console.error('usage: TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/register-webhook.mts <worker-url>');
  process.exit(2);
}

async function api(method: string, payload: unknown): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!body.ok) throw new Error(`${method}: ${body.description ?? res.status}`);
  return body.result;
}

await api('setWebhook', {
  url,
  secret_token: secret,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
});
await api('setMyCommands', {
  commands: [
    { command: 'topics', description: 'Выбрать тему' },
    { command: 'repeat', description: 'Показать текущее задание' },
    { command: 'why', description: 'Разобрать предыдущий ответ подробнее' },
    { command: 'skip', description: 'Показать ответ и получить следующее' },
    { command: 'stop', description: 'Закончить и увидеть итог' },
    { command: 'help', description: 'Справка' },
  ],
});
console.log(JSON.stringify(await api('getWebhookInfo', {}), null, 2));
