import { createChatServer } from './src/server.js';

const port = positivePort(process.env.PORT, 4567);
const host = process.env.HOST || '127.0.0.1';
const app = createChatServer();

await app.listen(port, host);
console.log(`Multiplayer chat available at http://${host}:${port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

function positivePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}
