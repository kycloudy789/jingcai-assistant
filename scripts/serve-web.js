#!/usr/bin/env node
/**
 * 本地预览静态站（零依赖）。用法：node scripts/serve-web.js [端口]
 * 默认 http://127.0.0.1:5173
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'web');
const PORT = Number(process.argv[2]) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
      return;
    }
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (readErr, buf) => {
      if (readErr) {
        res.writeHead(404).end('404');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`静态站已启动：http://127.0.0.1:${PORT}`);
  console.log('按 Ctrl+C 停止。');
});
