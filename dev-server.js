import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from './server/static-server.js';

export { createStaticServer };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT || 8080);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
    const server = createStaticServer({ root: path.dirname(fileURLToPath(import.meta.url)) });
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`HexSplitter: http://127.0.0.1:${server.address().port}`));
}
