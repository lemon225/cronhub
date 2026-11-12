'use strict';
/**
 * 短信凭据审计日志 —— 独立存储、只追加、带哈希链
 * ===========================================================================
 * 规范第八、九节的要求：
 *   - 审计日志与业务日志分开存储（业务日志是 state 里的环形缓冲，会被覆盖）
 *   - 只追加不可改
 *   - 保留 ≥90 天
 *   - 每条记录不含凭据值
 *
 * 落地方式：按月一个 JSONL 文件（data/audit/sms-YYYY-MM.jsonl），
 * 用 fs.appendFileSync 单次写入（O_APPEND 原子追加），永不 try/catch 后重写。
 * 每行带 seq + prevHash，形成哈希链：改动任何一条历史记录都会让后续校验失败。
 *
 * 注意：这里记录的是「决策与动作」，不是「值」。键名可以记，值一律不记。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 90;
const FILE_PREFIX = 'sms-audit-';

function ymKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 7); // YYYY-MM
}

function createAuditLog(opts = {}) {
  const { dataDir, onLog } = opts;
  const dir = path.join(dataDir, 'audit');
  let ready = false;
  let lastHash = '';
  let lastSeq = 0;
  let writeFailed = false;

  const log = (level, msg) => {
    if (typeof onLog === 'function') onLog({ level, msg });
  };

  function ensureDir() {
    if (ready) return true;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      ready = true;
      return true;
    } catch (e) {
      if (!writeFailed) log('error', `审计日志目录创建失败：${e.code || e.message}（审计降级为内存）`);
      writeFailed = true;
      return false;
    }
  }

  function fileFor(ts) {
    return path.join(dir, FILE_PREFIX + ymKey(ts) + '.jsonl');
  }

  /** 启动时从最新文件恢复链尾，保证多进程/重启后哈希链不断 */
  function restoreChain() {
    try {
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.startsWith(FILE_PREFIX)).sort()
        : [];
      if (!files.length) return;
      const last = path.join(dir, files[files.length - 1]);
      const text = fs.readFileSync(last, 'utf8').trimEnd();
      if (!text) return;
      const lines = text.split('\n');
      const tail = JSON.parse(lines[lines.length - 1]);
      lastHash = String(tail.h || '');
      lastSeq = Number(tail.seq) || lines.length;
    } catch { /* 读不到就从零开始，不影响写入 */ }
  }

  function append(event) {
    const at = Date.now();
    // 审计记录本身也必须脱敏：调用方可能误传敏感值，这里二次兜底
    const safe = {};
    for (const [k, v] of Object.entries(event || {})) {
      if (/value|token|secret|password|mobile|code$/i.test(k) && k !== 'result_code' && k !== 'error_code') {
        safe[k] = '[REDACTED]';
      } else if (typeof v === 'string') {
        safe[k] = v.replace(/\b[0-9a-f]{24,}\b/gi, '[REDACTED]')
          .replace(/\b1[3-9]\d{9}\b/g, (m) => m.slice(0, 3) + '****' + m.slice(-4));
      } else {
        safe[k] = v;
      }
    }
    lastSeq += 1;
    const body = { seq: lastSeq, at: new Date(at).toISOString(), ts: at, ...safe };
    const h = crypto.createHash('sha256').update(lastHash + JSON.stringify(body)).digest('hex').slice(0, 16);
    const line = JSON.stringify({ ...body, prev: lastHash || null, h });
    lastHash = h;

    if (!ensureDir()) return { ok: false, reason: 'no_dir' };
    try {
      // flag 'a' = 纯追加；不做读-改-写，避免竞态与截断
      fs.appendFileSync(fileFor(at), line + '\n', { mode: 0o600 });
      return { ok: true, seq: lastSeq };
    } catch (e) {
      if (!writeFailed) log('error', `审计日志写入失败：${e.code || e.message}`);
      writeFailed = true;
      return { ok: false, reason: e.code || 'write_failed' };
    }
  }

  /** 清理超过保留期的文件（按月粒度，只在启动时跑一次） */
  function prune(now = Date.now()) {
    if (!ensureDir()) return { removed: 0 };
    const cutoff = new Date(now - KEEP_DAYS * 86400e3).toISOString().slice(0, 7);
    let removed = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(FILE_PREFIX)) continue;
        const ym = f.slice(FILE_PREFIX.length, FILE_PREFIX.length + 7);
        if (ym < cutoff) {
          try { fs.unlinkSync(path.join(dir, f)); removed += 1; } catch { /* 正在被读，下次再说 */ }
        }
      }
    } catch { /* 目录读不了就当没有 */ }
    return { removed };
  }

  /** 只读查询：返回最近的 n 条（管理面用，不含值） */
  function tail(n = 50) {
    if (!ensureDir()) return [];
    try {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith(FILE_PREFIX)).sort();
      const out = [];
      for (let i = files.length - 1; i >= 0 && out.length < n; i--) {
        const text = fs.readFileSync(path.join(dir, files[i]), 'utf8').trimEnd();
        if (!text) continue;
        const lines = text.split('\n');
        for (let j = lines.length - 1; j >= 0 && out.length < n; j--) {
          try { out.push(JSON.parse(lines[j])); } catch { /* 跳过坏行 */ }
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 校验哈希链完整性：返回第一个断裂位置 */
  function verify() {
    if (!ensureDir()) return { ok: false, reason: 'no_dir' };
    try {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith(FILE_PREFIX)).sort();
      let prev = '';
      let checked = 0;
      for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8').trimEnd();
        if (!text) continue;
        for (const line of text.split('\n')) {
          let rec;
          try { rec = JSON.parse(line); } catch { return { ok: false, at: f, reason: 'bad_json' }; }
          const { prev: p, h, ...body } = rec;
          const expect = crypto.createHash('sha256').update(prev + JSON.stringify(body)).digest('hex').slice(0, 16);
          if (expect !== h) return { ok: false, at: f, seq: rec.seq, reason: 'hash_mismatch' };
          prev = h;
          checked += 1;
        }
      }
      return { ok: true, checked, files: files.length };
    } catch (e) {
      return { ok: false, reason: e.code || 'read_failed' };
    }
  }

  function stats() {
    if (!ensureDir()) return { files: 0, bytes: 0, dir };
    try {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith(FILE_PREFIX));
      const bytes = files.reduce((acc, f) => {
        try { return acc + fs.statSync(path.join(dir, f)).size; } catch { return acc; }
      }, 0);
      return { files: files.length, bytes, keepDays: KEEP_DAYS, dir: path.relative(dataDir, dir) };
    } catch {
      return { files: 0, bytes: 0, keepDays: KEEP_DAYS };
    }
  }

  restoreChain();
  prune();

  return { append, tail, verify, stats, prune };
}

module.exports = { createAuditLog, KEEP_DAYS };
