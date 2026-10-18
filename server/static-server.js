import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const PUBLIC_DIRECTORIES = new Set(['js', 'css', 'vendor', 'screenshots']);
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

/** Serve only public app assets, even when the checkout contains private development files. */
export function createStaticServer({ root = process.cwd() } = {}) {
    const base = fs.realpath(root);
    return http.createServer(async (req, res) => {
        const finish = (status, message) => {
            res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(req.method === 'HEAD' ? undefined : message);
        };
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.setHeader('Allow', 'GET, HEAD');
            finish(405, 'Method not allowed'); return;
        }
        let pathname;
        try { pathname = decodeURIComponent(req.url.split(/[?#]/, 1)[0]); }
        catch { finish(400, 'Invalid URL'); return; }
        if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) {
            finish(400, 'Invalid path'); return;
        }
        const parts = pathname.split('/').filter(Boolean);
        if (parts.some(part => part.startsWith('.'))) { finish(403, 'Forbidden'); return; }
        if (parts.length === 0) parts.push('index.html');
        if (!(parts.length === 1 && parts[0] === 'index.html') && !PUBLIC_DIRECTORIES.has(parts[0])) {
            finish(404, 'Not found'); return;
        }
        try {
            const realRoot = await base;
            const target = await fs.realpath(path.join(realRoot, ...parts));
            const relative = path.relative(realRoot, target);
            if (relative.startsWith('..') || path.isAbsolute(relative)) { finish(403, 'Forbidden'); return; }
            const resolvedParts = relative.split(path.sep);
            if (resolvedParts.some(part => part.startsWith('.')) ||
                (!(resolvedParts.length === 1 && resolvedParts[0] === 'index.html') && !PUBLIC_DIRECTORIES.has(resolvedParts[0]))) {
                finish(403, 'Forbidden'); return;
            }
            const type = MIME_TYPES[path.extname(target).toLowerCase()];
            if (!type || !(await fs.stat(target)).isFile()) { finish(404, 'Not found'); return; }
            const contents = await fs.readFile(target);
            res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': contents.length, 'Cache-Control': 'no-cache' });
            res.end(req.method === 'HEAD' ? undefined : contents);
        } catch (error) {
            finish(['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500, 'Not found');
        }
    });
}
