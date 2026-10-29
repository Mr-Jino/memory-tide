#!/usr/bin/env node
/**
 * 记忆潮汐 · 最小可跑实现
 *
 *   node scripts/tide.mjs scan  "<笔记目录>" [--days 90] [--limit 5] [--dry]
 *   node scripts/tide.mjs reply "<信的文件路径>"
 *
 * 设计要点：
 *  - 按「多久没被打开 + 多久没被链接」算水位，不按创建时间
 *  - 惰性核算：每次运行折算一次，不需要 cron（那个点上电脑大概率是关着的）
 *  - 只下沉，不删除。删不删由人决定，沉默 = 保留
 *  - 零依赖，Node 20+
 */

import fs from 'node:fs';
import path from 'node:path';

const TIDE_LINE = 0.35;   // 潮线：低于它就沉
// 新鲜度用半衰期指数衰减：半衰期 69 天，起点斜率与设计稿的「0.01/天」同量级，
// 但不会在 100 天后归零（线性版本有个已知缺陷：所有老笔记会变成一样"死"，
// 被引用过的和没被引用的再也分不开。文章第六节自曝过这个漏洞。）
const HALF_LIFE_DAYS = 69;
const LAMBDA = Math.LN2 / HALF_LIFE_DAYS;
const SKIP = new Set(['.git', '.obsidian', '.tide', 'node_modules', '潮汐日记']);

// ---------- 工具 ----------

function walk(dir, root = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') { if (SKIP.has(e.name)) continue; }
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, root, out);
    else if (e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

const rel = (root, full) => path.relative(root, full).replace(/\\/g, '/');
const stem = (full) => path.basename(full, path.extname(full));
const water = (freshness, touch) => freshness * (1 + Math.log1p(touch));

function loadState(root) {
  const p = path.join(root, '.tide', 'state.json');
  try { return { file: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch { return { file: p, data: { version: 1, files: {} } }; }
}

function saveState({ file, data }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- scan ----------

function scan(root, { days = 90, limit = 5, dry = false } = {}) {
  if (!fs.existsSync(root)) { console.error('目录不存在：' + root); process.exit(1); }
  const files = walk(root);
  if (!files.length) { console.log('这个目录里没有 .md 文件。'); return; }

  // 入链统计：别的笔记里出现 [[某篇的标题]] 的次数
  const names = new Set(files.map(stem));
  const inbound = new Map(files.map(f => [f, 0]));
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
      const target = m[1].trim();
      if (!names.has(target)) continue;
      const targetFile = files.find(x => stem(x) === target);
      if (targetFile && targetFile !== f) inbound.set(targetFile, (inbound.get(targetFile) || 0) + 1);
    }
  }

  const state = loadState(root);
  const now = Date.now();
  const rows = [];
  for (const f of files) {
    const key = rel(root, f);
    const st = state.data.files[key] || {};
    if (st.immune) continue;
    const mtime = fs.statSync(f).mtimeMs;
    const ageDays = Math.floor((now - mtime) / 86400000);
    if (ageDays < days) continue;                       // 还在观察窗内，不动它
    const freshness = Math.exp(-LAMBDA * ageDays);
    const touch = (inbound.get(f) || 0) + (st.touchExtra || 0);
    const w = water(freshness, touch);
    if (w >= TIDE_LINE) continue;                       // 潮线以上，不下沉
    rows.push({ file: f, key, title: stem(f), ageDays, cited: inbound.get(f) || 0, w });
  }

  rows.sort((a, b) => a.w - b.w);
  const picked = rows.slice(0, limit);

  if (!picked.length) {
    console.log(`扫了 ${files.length} 篇，没有水位低于潮线（${TIDE_LINE}）的。潮水很平静。`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# 潮汐日记 · ${today}`,
    '',
    `今天潮水退了一点。有 ${picked.length} 件事，我很久没听你提起了。`,
    '',
    '---',
    ''
  ];
  picked.forEach((r, i) => {
    lines.push(`**#${i + 1}**`);
    lines.push(`关于：${r.title}`);
    lines.push(`最后动过：${r.ageDays} 天前 · 被其它笔记引用 ${r.cited} 次`);
    lines.push(`水位：${r.w.toFixed(3)}（潮线 ${TIDE_LINE}）`);
    lines.push('');
    lines.push('> 我想把它沉到底层。还想留着的话，告诉我。');
    lines.push('');
    lines.push('<!-- 只在下面写「同意」或「拒绝」，别改上面的内容 -->');
    lines.push(`<!-- id: ${r.key} -->`);
    lines.push('回复：');
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  lines.push('同意 = 沉一层（不删除，还搜得到）；拒绝 = 捞回水面；留空 = 保留，先不问了。');

  const text = lines.join('\n');
  console.log(text);

  if (dry) { console.log('\n[--dry] 没有落盘。'); return; }

  const dir = path.join(root, '潮汐日记');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${today}.md`);
  const exist = fs.existsSync(out);
  fs.writeFileSync(out, exist ? fs.readFileSync(out, 'utf8') + '\n\n' + text : text, 'utf8');
  console.log(`\n信用追加方式写到：${out}${exist ? '（今天已有，追加在后面）' : ''}`);
}

// ---------- reply ----------

const VERBS = ['同意', '拒绝'];

function reply(letterPath) {
  if (!fs.existsSync(letterPath)) { console.error('找不到这封信：' + letterPath); process.exit(1); }
  const root = path.dirname(path.dirname(letterPath));  // 潮汐日记/xx.md → 库根
  const state = loadState(root);
  // Windows 编辑器（记事本 / Obsidian / python 写文件）常把换行存成 CRLF，
  // 不归一化的话按 --- 分块会整封认成一段 —— 这个坑实测踩到过。
  const text = fs.readFileSync(letterPath, 'utf8').replace(/\r\n/g, '\n');

  const blocks = text.split(/\n---\n/).filter(b => b.includes('关于：'));
  let agreed = 0, declined = 0, blank = 0, unknown = 0;
  const report = [];

  for (const b of blocks) {
    const idM = b.match(/<!--\s*id:\s*(.+?)\s*-->/);
    const title = (b.match(/关于：(.+)/) || [])[1]?.trim() ?? '(未知)';
    const rawReply = (b.match(/回复：(.*)/) || [])[1] ?? '';
    const clean = rawReply.replace(/[。，,.!！?？\s　]/g, '');
    if (!idM) { report.push(['跳过', title, '没有 id 注释，可能是手写的段落']); continue; }
    const key = idM[1].trim();
    const st = state.data.files[key] ||= { touchExtra: 0, tideCount: 0, declineCount: 0, immune: false };

    if (clean === '') { blank++; report.push(['保留', title, '没写答复 = 保留，下次隔久点再问']); continue; }

    if (clean.startsWith('同意')) {
      st.tideCount = (st.tideCount || 0) + 1;
      st.lastAskedAt = Date.now();
      if (st.tideCount >= 2) report.push(['可删', title, `已下沉 ${st.tideCount} 次，可以物理删除了（脚本不会替你删）`]);
      else report.push(['下沉', title, `沉到底层第 ${st.tideCount} 次，文件没动，还搜得到`]);
      agreed++;
    } else if (clean.startsWith('拒绝')) {
      st.declineCount = (st.declineCount || 0) + 1;
      st.tideCount = 0;
      st.touchExtra = (st.touchExtra || 0) + 0.3;
      if (st.declineCount >= 3) { st.immune = true; report.push(['免疫', title, '拒绝 3 次了，以后不再问']); }
      else report.push(['捞回', title, `新鲜度回满、触动 +0.3（拒绝 ${st.declineCount} 次）`]);
      declined++;
    } else {
      st.replyRaw = rawReply;
      unknown++;
      report.push(['存疑', title, `写了「${rawReply.trim().slice(0, 20)}」，不是同意/拒绝，按未回复处理`]);
    }
  }

  saveState(state);
  console.log(`收到 ${blocks.length} 条：同意 ${agreed} · 拒绝 ${declined} · 留空 ${blank} · 存疑 ${unknown}\n`);
  for (const [tag, title, note] of report) console.log(`  [${tag}] ${title} — ${note}`);
  console.log('\n没有任何文件被删除。要删请你自己动手。');
}

// ---------- CLI ----------

const [cmd, target, ...rest] = process.argv.slice(2);
const opt = (name, def) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 ? Number(rest[i + 1]) : def;
};
if (cmd === 'scan') scan(target, { days: opt('days', 90), limit: opt('limit', 5), dry: rest.includes('--dry') });
else if (cmd === 'reply') reply(target);
else {
  console.log('用法：');
  console.log('  node scripts/tide.mjs scan  "<笔记目录>" [--days 90] [--limit 5] [--dry]');
  console.log('  node scripts/tide.mjs reply "<信的文件路径>"');
  process.exit(1);
}
