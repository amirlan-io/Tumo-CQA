import { createApp } from './app.js';
import { createStore } from './store.js';
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const store = createStore(process.env.DB_PATH ?? 'data/cqa.sqlite');
const server = createApp(store).listen(port, host, () => console.log(`Tumo CQA: http://${host}:${port}/api/health`));
function shutdown() { server.close(() => { store.db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
