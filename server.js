// ローカル専用の静的ファイルサーバー（外部依存なし）
// public/ をルートとして配信し、ffmpeg.wasm 関連ファイルを /vendor/ 配下にマッピングする
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1'; // 外部から接続できないようローカルのみに限定
const PORT = Number(process.env.PORT) || 8080;

// URLプレフィックスと実ディレクトリの対応表
const ROUTES = [
  { prefix: '/vendor/ffmpeg/', dir: path.join(__dirname, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm') },
  { prefix: '/vendor/core/', dir: path.join(__dirname, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm') },
  { prefix: '/', dir: path.join(__dirname, 'public') },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

/**
 * レスポンスにテキストを返す
 * @param {http.ServerResponse} res レスポンス
 * @param {number} status HTTPステータス
 * @param {string} message 本文
 */
function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/**
 * リクエストURLから実ファイルのパスを解決する（ディレクトリトラバーサル対策込み）
 * @param {string} urlPath リクエストのパス部分
 * @returns {string|null} 解決できた絶対パス。不正な場合は null
 */
function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // 不正なURLエンコード
  }
  if (decoded.includes('\0')) return null;
  if (decoded === '/') decoded = '/index.html';

  const route = ROUTES.find((r) => decoded.startsWith(r.prefix));
  if (!route) return null;

  const relative = decoded.slice(route.prefix.length);
  const full = path.resolve(route.dir, relative);
  // 解決後のパスが対象ディレクトリの外に出ていないことを確認する
  if (full !== route.dir && !full.startsWith(route.dir + path.sep)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  let pathname;
  try {
    pathname = new URL(req.url, `http://${HOST}`).pathname;
  } catch {
    return sendText(res, 400, 'Bad Request');
  }

  const file = resolveFile(pathname);
  if (!file) return sendText(res, 404, 'Not Found');

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, 'Not Found');

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(file);
    stream.on('error', (e) => {
      console.error('ファイル読み込みエラー:', e.message);
      res.destroy(e);
    });
    stream.pipe(res);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は使用中です。PORT環境変数で別のポートを指定してください。`);
  } else {
    console.error('サーバーエラー:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`起動しました: http://${HOST}:${PORT}/`);
});
