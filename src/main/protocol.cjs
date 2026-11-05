const fs = require('node:fs');
const path = require('node:path');
const { ROOT, RENDERER } = require('./paths.cjs');

function registerProtocol({ protocol, voices, library }) {
  const vendor = new Map([
    ['/vendor/pixi.js', path.join(ROOT, 'node_modules/pixi.js/dist/pixi.min.js')],
    ['/vendor/pixi-spine.js', path.join(ROOT, 'node_modules/pixi-spine/dist/pixi-spine.js')]
  ]);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.atlas': 'text/plain; charset=utf-8', '.skel': 'application/octet-stream', '.mp3': 'audio/mpeg' };
  protocol.handle('arkpet', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
      const pathname = decodeURIComponent(url.pathname);
      let file = vendor.get(pathname);
      if (pathname.startsWith('/voices/')) {
        const pieces = pathname.split('/');
        if (pieces.length !== 4) return new Response('Forbidden', { status: 403 });
        file = voices.resolve(pieces[2], pieces[3]);
        if (!file) return new Response('Not found', { status: 404 });
      }
      if (pathname.startsWith('/models/')) {
        const pieces = pathname.split('/');
        if (pieces.length !== 4) return new Response('Forbidden', { status: 403 });
        file = library.resolve(pieces[2], pieces[3]);
        if (!file) return new Response('Not found', { status: 404 });
      }
      if (!file) {
        const base = pathname.startsWith('/renderer/') ? RENDERER : pathname.startsWith('/assets/') ? path.join(ROOT, 'assets') : null;
        if (!base) return new Response('Not found', { status: 404 });
        file = path.resolve(base, pathname.split('/').slice(2).join('/'));
        const relative = path.relative(base, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
      }
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'Content-Type': mime[path.extname(pathname)] || mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

module.exports = { registerProtocol };
