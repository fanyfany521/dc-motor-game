/* 直流电机结构闯关游戏 —— 云端汇总服务器（零依赖，仅用 Node 内置模块）
 * 学生每完成一轮，浏览器把成绩快照 POST 到 /api/record；
 * 教师用 /api/records（带教师号+姓名）拉取全部学生汇总。
 * 数据落盘到 data/records.jsonl（追加写），启动载入内存聚合。
 * 部署：node server.js （监听 process.env.PORT || 3000）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'records.jsonl');
// 游戏页面：默认优先用原名，找不到再尝试常见改名，部署时改名也不会打不开
function findHtml() {
  const cands = [
    process.env.GAME_HTML,
    path.join(__dirname, '直流电机结构闯关游戏.html'),
    path.join(__dirname, 'game.html'),
    path.join(__dirname, 'index.html')
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[cands.length - 1];
}
const HTML_FILE = findHtml();
const TEACHER = { id: '123', name: 'F' };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 内存中每个学号的最新快照
let mem = {};
// 串行追加写，避免并发交错损坏文件
let writeChain = Promise.resolve();

function loadDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const lines = fs.readFileSync(DATA_FILE, 'utf8').split('\n').filter(Boolean);
      for (const ln of lines) {
        try { const r = JSON.parse(ln); if (r && r.sid) mem[r.sid] = r; } catch (e) {}
      }
      console.log(`已载入历史成绩 ${Object.keys(mem).length} 条`);
    }
  } catch (e) { console.error('载入历史失败:', e); }
}
loadDisk();

function appendLine(record) {
  writeChain = writeChain.then(() => new Promise(res => {
    fs.appendFile(DATA_FILE, JSON.stringify(record) + '\n', () => res());
  }));
  return writeChain;
}

function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

function isTeacher(sid, name) {
  return sid === TEACHER.id && name === TEACHER.name;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // ---- 学生提交成绩 ----
  if (p === '/api/record' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let rec;
      try { rec = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (!rec || typeof rec.sid !== 'string' || !/^\d{3,15}$/.test(rec.sid) || !rec.name) {
        return sendJSON(res, 400, { error: 'invalid_record' });
      }
      const clean = {
        sid: rec.sid,
        name: String(rec.name).slice(0, 20),
        score: +rec.score || 0,
        attempts: +rec.attempts || 0,
        success: +rec.success || 0,
        firstTime: rec.firstTime || '',
        lastTime: rec.lastTime || '',
        history: Array.isArray(rec.history) ? rec.history.slice(-50) : [],
        cleared: rec.cleared || {},
        best: rec.best || {},
        fails: rec.fails || {},
        isTeacher: !!rec.isTeacher,
        ts: Date.now()
      };
      // 保留“最好成绩”快照：分数更高优先；同分则通关数更多者优先；否则取最新
      const prev = mem[clean.sid];
      const prevScore = prev ? prev.score : -1;
      const prevCleared = prev ? Object.keys(prev.cleared || {}).length : 0;
      const curCleared = Object.keys(clean.cleared || {}).length;
      const better = !prev || clean.score > prevScore
        || (clean.score === prevScore && curCleared > prevCleared);
      if (better) mem[clean.sid] = clean;
      appendLine(clean).then(() => sendJSON(res, 200, { ok: true }));
    });
    return;
  }

  // ---- 教师拉取汇总 ----
  if (p === '/api/records' && req.method === 'GET') {
    const sid = u.searchParams.get('sid') || '';
    const name = u.searchParams.get('name') || '';
    if (!isTeacher(sid, name)) return sendJSON(res, 401, { error: 'unauthorized' });
    const students = Object.values(mem).map(s => {
      const { ts, ...rest } = s; return rest;
    });
    return sendJSON(res, 200, {
      students, teacher: TEACHER.name,
      serverTime: new Date().toISOString(), count: students.length
    });
  }

  // ---- 教师清空（先备份再清空） ----
  if (p === '/api/clear' && req.method === 'POST') {
    const sid = u.searchParams.get('sid') || '';
    const name = u.searchParams.get('name') || '';
    if (!isTeacher(sid, name)) return sendJSON(res, 401, { error: 'unauthorized' });
    try {
      if (fs.existsSync(DATA_FILE)) {
        fs.renameSync(DATA_FILE, DATA_FILE + '.bak.' + Date.now());
      }
    } catch (e) {}
    mem = {};
    return sendJSON(res, 200, { ok: true });
  }

  // ---- 静态页面：游戏 / 教师后台（同源） ----
  if (p === '/' || p === '/admin' || p === '/index.html') {
    fs.readFile(HTML_FILE, (err, buf) => {
      if (err) { res.writeHead(500); res.end('找不到游戏页面: ' + HTML_FILE); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`直流电机闯关服务已启动 → http://localhost:${PORT}`);
  console.log(`游戏页面: /   教师后台: /admin   数据文件: ${DATA_FILE}`);
});
