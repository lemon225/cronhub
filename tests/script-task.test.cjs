/*
 * 青龙式脚本任务：验证 worker 执行内核 + 接线。
 *
 * 这一版重点守住 2026-11-21 复盘出来的几个真问题：
 *   ① await 之后的同步死循环会把主进程按死 —— 必须由外面 terminate；
 *   ② 注入宿主内建（Array/Date/String…）时，Array.constructor('return process')()
 *      能直接拿到 process —— 现在只注入 facade 包装过的能力；
 *   ③ 多步骤里的脚本步骤因为「没有 url」被 stepsOf 静默丢掉；
 *   ④ 通知层无条件给脚本任务回 ✅，多步骤失败时也报成功。
 * 跑法：node tests/script-task.test.cjs
 */
'use strict';
const { Worker } = require('node:worker_threads');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const RUNNER = path.join(ROOT, 'lib', 'script-runner.cjs');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

/** 按主进程同样的协议驱动内核；超时由这里 terminate —— 正是 server.js 的做法 */
function run(code, { timeoutMs = 8000, env = {}, guardPrivate = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const w = new Worker(RUNNER, {
      workerData: { code, env, guardPrivate, outputMax: 20000, stepName: 't', fetchTimeoutMs: 5000 },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    let logs = '';
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.terminate();
      resolve({ ...payload, ms: Date.now() - t0, logs });
    };
    const timer = setTimeout(() => done({ ok: false, error: 'HARD_TIMEOUT' }), timeoutMs + 750);
    w.on('message', (m) => {
      if (m.type === 'log') { logs += (logs ? '\n' : '') + m.line; return; }
      if (m.type === 'done') done({ ok: true, text: m.text });
      if (m.type === 'fail') done({ ok: false, error: m.message });
    });
    w.on('error', (e) => done({ ok: false, error: 'WORKER_ERR ' + e.message }));
    w.on('exit', (c) => done({ ok: false, error: 'EXIT ' + c }));
  });
}

(async () => {
  console.log('\n[1] 基础执行');
  {
    const r = await run('console.log("开始"); console.log("KEY=" + env.TOKEN); return "完成";', { env: { TOKEN: 'abc123' } });
    ok('脚本成功', r.ok, r);
    ok('console 输出被收集', /开始/.test(r.logs) && /KEY=abc123/.test(r.logs), r.logs);
    ok('返回值追加在日志之后', /完成$/.test(String(r.text).trim()), r.text);
    const ro = await run('try { env.TOKEN = "x"; } catch (e) { /* 严格模式才抛 */ } return env.TOKEN;', { env: { TOKEN: 'abc123' } });
    ok('env 只读（赋值不生效）', String(ro.text).trim() === 'abc123', ro.text);
  }

  console.log('\n[2] 死循环与超时');
  {
    const r = await run('while(true){}', { timeoutMs: 8000 });
    ok('同步死循环被同步段闸截断', !r.ok && /同步代码执行超过 5 秒/.test(String(r.error)), r.error);
    ok('同步闸在 6 秒内返回', r.ms < 6500, r.ms);
  }
  {
    const r = await run('await sleep(20); while(true){}', { timeoutMs: 1500 });
    ok('await 后死循环由外层强制终止', !r.ok && r.error === 'HARD_TIMEOUT', r.error);
    ok('外层终止在 3 秒内生效', r.ms < 3000, r.ms);
  }
  {
    const r = await run('await sleep(60000); return "不该等到";', { timeoutMs: 1000 });
    ok('长时间 sleep 也会被终止（不再变成僵尸脚本）', !r.ok && r.error === 'HARD_TIMEOUT', r.error);
  }

  console.log('\n[3] 逃逸防护（真实向量）');
  {
    let leaked = '';
    for (const [label, code] of [
      ['Array.constructor', 'return Array.constructor("return typeof process")();'],
      ['console.log.constructor', 'return console.log.constructor("return typeof process")();'],
      ['env.constructor', 'return env.constructor.constructor("return typeof process")();'],
      ['async 返回值原型', 'const p = sleep(1); return p.constructor.constructor("return typeof process")();'],
      ['函数原型链', 'return Object.getPrototypeOf(async function(){}).constructor("return typeof process")();'],
    ]) {
      const r = await run(code);
      if (r.ok) leaked += label + '=' + String(r.text).trim() + ' ';
    }
    ok('构造函数逃逸全部被阻断', !leaked, leaked);
    const r2 = await run('return [typeof require, typeof process, typeof __host, typeof module].join(",");');
    ok('require/process/宿主桥不可见', String(r2.text).trim() === 'undefined,undefined,undefined,undefined', r2.text);
  }
  {
    const before = typeof Object.constructor;
    await run('Object.constructor = undefined; Function.constructor = undefined; return 1;');
    ok('不再污染主进程全局对象', typeof Object.constructor === before && before === 'function', typeof Object.constructor);
  }

  console.log('\n[4] 兼容能力');
  {
    const r = await run('const u = new URL("https://a.com:8443/x/y?a=1&b=2");'
      + ' const q = new URLSearchParams({ x: "1", y: "啊" });'
      + ' return u.hostname + "|" + u.pathname + "|" + u.searchParams.get("b") + "|" + q.toString();');
    ok('URL / URLSearchParams 可用', String(r.text).trim() === 'a.com|/x/y|2|x=1&y=%E5%95%8A', r.text);
    const t = await run('const b = new TextEncoder().encode("中文"); return new TextDecoder().decode(b) + "|" + btoa("hi");');
    ok('TextEncoder / TextDecoder / btoa 可用', String(t.text).trim() === '中文|aGk=', t.text);
    const c = await run('const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));'
      + ' return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");');
    ok('crypto.subtle.digest 可用', String(c.text).trim() === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', c.text);
    const s = await run('return await new Promise((r) => setTimeout(() => r("timer-ok"), 30));');
    ok('setTimeout 可用', String(s.text).trim() === 'timer-ok', s.text);
    const wt = await run('const t = Date.now(); await wait(50); return Date.now() - t >= 40 ? "wait-ok" : "wait-short";');
    ok('wait 别名可用（sleep(数字) 会被网关 WAF 拦）', String(wt.text).trim() === 'wait-ok', wt.text);
  }

  console.log('\n[5] fetch 与私网防护');
  const srv = http.createServer((req, res) => {
    if (req.url === '/empty') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(''); return; }
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 0, echo: req.url, ua: req.headers['x-token'],
        method: req.method, body: buf, ct: String(req.headers['content-type'] || ''),
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  {
    const r = await run(`const r = await fetch("http://127.0.0.1:${port}/api/checkin?t={{TOKEN}}", { headers: { "x-token": "tk" } });
      const d = await r.json();
      console.log("status=" + r.status);
      return d.echo + "|" + d.ua + "|" + r.headers.get("content-type");`, { env: { TOKEN: 'abc123' } });
    ok('fetch 可用且 {{变量}} 被替换', /\/api\/checkin\?t=abc123/.test(String(r.text)), r.text);
    ok('响应头与 JSON 解析正常', /tk\|application\/json/.test(String(r.text)), r.text);
  }
  {
    const r = await run(`await fetch("http://127.0.0.1:${port}/x"); return "不该到这里";`, { guardPrivate: true });
    ok('私网防护开启时拦截内网地址', !r.ok && /私网地址被拦截/.test(String(r.error)), r.error);
  }

  console.log('\n[5b] 请求体与错误可读性');
  {
    const form = await run(`const p = new URLSearchParams({ a: "1", b: "啊" });
      const r = await fetch("http://127.0.0.1:${port}/form", { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" }, body: p });
      return (await r.json()).body;`);
    ok('URLSearchParams 请求体按表单序列化', String(form.text).trim() === 'a=1&b=%E5%95%8A', form.text);

    const json = await run(`const r = await fetch("http://127.0.0.1:${port}/j", { method: "POST",
      headers: { "content-type": "application/json" }, body: { a: 1 } });
      return (await r.json()).body;`);
    ok('对象请求体仍是 JSON', String(json.text).trim() === '{"a":1}', json.text);

    const bin = await run(`const r = await fetch("http://127.0.0.1:${port}/bin", { method: "POST",
      body: new TextEncoder().encode("raw-bytes") });
      return (await r.json()).body;`);
    ok('Uint8Array 请求体按 UTF-8 解码', String(bin.text).trim() === 'raw-bytes', bin.text);

    const hs = await run(`const h = new Headers({ "x-token": "h1" });
      const r = await fetch("http://127.0.0.1:${port}/h", { headers: h });
      return (await r.json()).ua + "|" + h.get("x-token");`);
    ok('Headers 类可用且能传给 fetch', String(hs.text).trim() === 'h1|h1', hs.text);

    const envAll = await run(`const r = await fetch("http://127.0.0.1:${port}/e", { method: "POST",
      headers: { "x-token": "{{TK}}" }, body: "k={{TK}}" });
      const d = await r.json(); return d.ua + "|" + d.body;`, { env: { TK: 'v9' } });
    ok('脚本 fetch 的头与体都替换 {{变量}}', String(envAll.text).trim() === 'v9|k=v9', envAll.text);

    const emptyJson = await run(`const r = await fetch("http://127.0.0.1:${port}/empty");
      try { await r.json(); return "parsed"; } catch (e) { return e.message; }`);
    ok('空响应解析 JSON 给出可读原因', /响应正文为空/.test(String(emptyJson.text)), emptyJson.text);

    const where = await run('const a = 1;\nconst b = 2;\nnoSuchFn();');
    ok('运行时错误带行号', /第 3 行/.test(String(where.error)), where.error);

    const syn = await run('const a = 1;\nreturn (');
    ok('语法错误点明类型与行号', /语法错误/.test(String(syn.error)) && /第 2 行/.test(String(syn.error)), syn.error);

    const longWait = await run('try { await wait(70000); return "no-error"; } catch (e) { return e.message; }');
    ok('wait 超过 60 秒显式报错，不静默截断', /60000/.test(String(longWait.text)) && !/no-error/.test(String(longWait.text)), longWait.text);
  }
  srv.close();

  console.log('\n[6] 输出上限');
  {
    const r = await run('for (let i = 0; i < 3000; i++) console.log("x".repeat(50)); return "done";');
    ok('输出被截到 20000 字符并标注截断', String(r.text).length <= 20100 && /已截断/.test(String(r.text)), String(r.text).length);
    ok('截断后仍算成功', r.ok, r.error);
  }

  console.log('\n[6b] 通知正文字节闸（FCM 单条 4096B）');
  {
    const CLIP_SRC = SRC.slice(SRC.indexOf('const NOTICE_BODY_MAX_BYTES'), SRC.indexOf('/**\n * 生成推送内容'));
    const clipNoticeBytes = new Function(CLIP_SRC + '\nreturn clipNoticeBytes;')();
    ok('短正文不动', clipNoticeBytes('短正文') === '短正文');
    const long = '中'.repeat(2000);
    const clipped = clipNoticeBytes(long);
    ok('超长正文截到 3600 字节内并加省略号',
      Buffer.byteLength(clipped, 'utf8') <= 3600 && /…$/.test(clipped), Buffer.byteLength(clipped, 'utf8'));
  }

  console.log('\n[7] 接线：步骤过滤 / 通知标题 / 环境变量');
  {
    const STEPS_SRC = SRC.slice(SRC.indexOf('function stepsOf(task) {'), SRC.indexOf('/**\n * 串行跑完所有步骤'));
    const stepsOf = new Function(STEPS_SRC + '\nreturn stepsOf;')();
    const multi = {
      name: '多步脚本',
      config: {
        url: '',
        steps: [
          { name: '第一步', script: 'return 1;' },
          { name: '第二步', url: 'https://example.com/a' },
        ],
      },
    };
    const got = stepsOf(multi);
    ok('脚本步骤不再被丢弃', got.length === 2 && got[0].script === 'return 1;', got.map((s) => s.name));
    ok('HTTP 步骤不会继承任务级脚本', !got[1].script, got[1].script);
  }
  {
    const ENV_SRC = SRC.slice(SRC.indexOf('function safeScriptEnv() {'), SRC.indexOf('/**\n * 在 worker 线程里跑一段脚本'));
    const envOf = new Function('const state=' + JSON.stringify({
      settings: { envVars: [
        { key: 'ON', value: '1', enabled: true },
        { key: 'OFF', value: '2', enabled: false },
        { key: 'NOSW', value: '3' },
        { key: 'bad-key', value: '4', enabled: true },
      ] },
    }) + ';' + ENV_SRC + '\nreturn safeScriptEnv;')();
    const env = envOf();
    ok('停用的变量不下发给脚本', env.ON === '1' && env.OFF === undefined, env);
    ok('非法变量名被丢弃', env['bad-key'] === undefined, env);
  }
  ok('通知标题按整体结果出 ✅/❌', /\(ok \? '✅ ' : '❌ '\) \+ task\.name/.test(SRC));
  {
    const TRANS_SRC = SRC.slice(SRC.indexOf('function isTransientFailure(err) {'), SRC.indexOf('/*\n * 任务依赖'));
    const isTransient = new Function(TRANS_SRC + '\nreturn isTransientFailure;')();
    ok('脚本失败不再当成可重试失败', isTransient({ scriptFailure: true }) === false);
    ok('普通连接层失败仍可重试', isTransient({}) === true);
    ok('脚本错误会打 scriptFailure 标记', /e\.scriptFailure = true;/.test(SRC));
  }
  ok('脚本执行不再走主进程 vm', !/vm\.runInContext/.test(SRC) && /new Worker\(SCRIPT_RUNNER/.test(SRC));

  if (failures) { console.log(`\n失败 ${failures} 项`); process.exit(1); }
  console.log('\n全部通过');
})().catch((e) => { console.error('测试异常:', (e && e.stack) || e); process.exit(1); });
