// Express static server for local testing of dist/.
//   node test/server.js [port]
import express from 'express';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'dist');

export function startServer(port = 8080) {
  const app = express();
  app.use(express.static(root, {etag: false, cacheControl: false}));
  return new Promise(resolve => {
    const server = app.listen(port, () => resolve(server));
  });
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8080);
  await startServer(port);
  console.log(`serving ${root} at http://localhost:${port}/`);
}
