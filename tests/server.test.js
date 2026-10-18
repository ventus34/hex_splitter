import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStaticServer } from '../server/static-server.js';

test('static server serves app assets and rejects traversal, private files and escaping symlinks', async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hexsplitter-server-'));
    const root = path.join(temporary, 'public');
    await fs.mkdir(path.join(root, 'js'), { recursive: true });
    await fs.mkdir(path.join(root, '.git'));
    await fs.mkdir(path.join(root, 'private'));
    await fs.writeFile(path.join(root, 'index.html'), '<h1>HexSplitter</h1>');
    await fs.writeFile(path.join(root, 'js/app.js'), 'export default 1;');
    await fs.writeFile(path.join(root, '.git/config'), 'fixture-private-config');
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await fs.writeFile(path.join(temporary, 'outside.js'), 'fixture-outside');
    await fs.writeFile(path.join(root, 'private/secret.js'), 'fixture-private');
    await fs.symlink(path.join(temporary, 'outside.js'), path.join(root, 'js/link.js'));
    await fs.symlink(path.join(root, 'private/secret.js'), path.join(root, 'js/private.js'));
    const server = createStaticServer({ root });
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await fs.rm(temporary, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const request = (url, method = 'GET') => new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method }, res => {
            let body = '';
            res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject); req.end();
    });
    const home = await request('/');
    assert.equal(home.status, 200);
    assert.match(home.body, /HexSplitter/);
    assert.match(home.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    const script = await request('/js/app.js?v=1');
    assert.equal(script.status, 200);
    assert.match(script.headers['content-type'], /text\/javascript/);
    for (const url of ['/../outside.js', '/js/../../outside.js', '/%2e%2e/outside.js', '/js%2f..%2f..%2foutside.js', '/.git/config', '/js/link.js', '/js/private.js']) {
        const response = await request(url);
        assert.equal(response.status, 403, url);
        assert.doesNotMatch(response.body, /fixture-private|fixture-outside/);
    }
    assert.equal((await request('/package.json')).status, 404);
    assert.equal((await request('/%GG')).status, 400);
    assert.equal((await request('/js%5c..%5c')).status, 400);
    assert.equal((await request('/', 'POST')).status, 405);
    const head = await request('/', 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(home.body));
});
