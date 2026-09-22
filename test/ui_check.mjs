// ui_check.mjs — 真实浏览器端到端验证（补上 Node 测试覆盖不到的那一层）。
//
// 为什么必须有这一层：
//   api_test.mjs 用 Node 跑逻辑层，全绿**不等于**浏览器里能用。
//   已栽过的两个跟头都只有真浏览器才看得见：
//     ① vendor/sql-wasm.js 是 UMD 包，浏览器用 import() 取不到导出 → 数据库起不来；
//     ② index.html 里写绝对路径 /style.css，本地根路径恰好能命中，挂到 /<仓库名>/ 下就 404 → 样式全丢。
//   所以每次动到 index.html / 加载方式 / 路径，都跑一遍这个脚本。
//
// 依赖：本机已装 Chrome（macOS 默认路径，可用 CHROME_BIN 覆盖）。
// 用法：
//   1) 先把页面挂到一个**子路径**下（模拟 GitHub Pages，用根路径测会漏掉绝对路径问题）：
//        mkdir -p /tmp/site/business-flow
//        cp -R app.js index.html style.css js vendor /tmp/site/business-flow/
//        python3 -m http.server 8098 --directory /tmp/site
//   2) CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//      node test/ui_check.mjs http://127.0.0.1:8098/business-flow/
//
// 产出：终端逐页结论 + /tmp/ui-*.png 截图（可直接看观感）。
import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { existsSync } from "fs";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] || "http://127.0.0.1:8098/business-flow/";
const PORT = Number(process.env.CDP_PORT || 9224);
const OUT = process.env.SHOT_PREFIX || "/tmp/ui";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(CHROME)) {
  console.error(`未找到 Chrome：${CHROME}\n用 CHROME_BIN 指定路径。`);
  process.exit(1);
}

const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
  "--no-proxy-server", "--disable-dev-shm-usage", "--disable-extensions",
  "--window-size=1440,1100",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/cbprof_ui", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => { chromeErr += d.toString(); });

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch {}
    await sleep(300);
  }
  throw new Error("DevTools 端口未就绪\n" + chromeErr.slice(-1200));
}

let seq = 0;
function rpc(ws, method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    const h = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      ws.removeEventListener("message", h);
      m.error ? rej(new Error(method + " → " + JSON.stringify(m.error))) : res(m.result);
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener("message", h); rej(new Error(method + " 超时")); }, 30000);
  });
}

const errors = [];
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 220) : ""}`); }
};

try {
  await waitPort();
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("WebSocket 连接失败")); });

  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push("未捕获异常: " + (d.exception?.description || d.text));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push("console.error: " + (m.params.args || []).map((a) => a.value ?? a.description).join(" "));
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      errors.push(`资源错误: ${m.params.entry.text} ${m.params.entry.url || ""}`);
    }
  });

  await rpc(ws, "Runtime.enable");
  await rpc(ws, "Log.enable");
  await rpc(ws, "Page.enable");
  // 在页面脚本之前挂钩，页面自身的报错一条都漏不掉
  await rpc(ws, "Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__errs = [];
      window.addEventListener('error', e => window.__errs.push('error: ' + (e.message || e) + ' @' + (e.filename || '')));
      window.addEventListener('unhandledrejection', e => window.__errs.push('unhandled: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));
    `,
  });

  await rpc(ws, "Page.navigate", { url: BASE });

  const ev = async (expr) =>
    (await rpc(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
  const shot = async (name) => {
    const s = await rpc(ws, "Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}-${name}.png`, Buffer.from(s.data, "base64"));
  };

  console.log(`\n=== 真实浏览器验证：${BASE} ===`);
  console.log("\n── 启动 ──");
  // 首次打开要下约 320KB 的 SQLite 引擎（gzip 后），慢网下几十秒很正常，
  // 所以这里**轮询等就绪**，不要死等一个固定秒数（死等会把正常的慢加载误报成坏页）。
  const BOOT_WAIT = Number(process.env.BOOT_WAIT_MS || 120000);
  const t0 = Date.now();
  let ready = false, lastMsg = "";
  for (let t = 0; t < BOOT_WAIT; t += 1000) {
    const st = await ev(`(() => { const b = document.querySelector('#bootMask');
      return { hidden: !!b && getComputedStyle(b).display === 'none',
               msg: (document.querySelector('#bootMsg') || {}).innerText || '' }; })()`);
    if (st && st.msg) lastMsg = st.msg;
    if (st && st.hidden) { ready = true; break; }
    if (t > 0 && t % 5000 === 0) console.log(`  …等待启动 ${(t / 1000).toFixed(0)}s：${lastMsg}`);
    await sleep(1000);
  }
  console.log(`  启动用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  check(`启动完成（${BOOT_WAIT / 1000}s 内遮罩隐藏）`, ready, lastMsg);
  check("样式已加载（侧边栏宽度生效）", (await ev(`getComputedStyle(document.querySelector('aside')).width`)) !== "auto");
  check("sql.js 已就绪", (await ev(`typeof window.initSqlJs`)) === "function");
  check("侧边导航 8 项", (await ev(`document.querySelectorAll('#nav a').length`)) === 8);
  check("看板已渲染", (await ev(`document.querySelector('#view').children.length`)) > 0);
  check("提醒角标已出数", (await ev(`(document.querySelector('#navRemind')||{}).innerText`)) !== "0");
  check("无页面内错误", (await ev(`JSON.stringify(window.__errs)`)) === "[]", await ev(`JSON.stringify(window.__errs)`));
  await shot("01-dashboard");

  await ev(`document.querySelector('#keySkip').click()`);
  await sleep(500);
  check("Key 引导可关闭", (await ev(`getComputedStyle(document.querySelector('#keyBox')).display`)) === "none");

  const views = [["process", "业务进程"], ["customers", "客户"], ["quotations", "报价"],
    ["contracts", "合同"], ["templates", "模板库"], ["reminders", "提醒"],
    ["assistant", "智能助手"], ["settings", "设置"]];
  let i = 1;
  for (const [v, label] of views) {
    await ev(`document.querySelector('#nav a[data-v="${v}"]').click()`);
    await sleep(1400);
    const info = await ev(`(() => { const view = document.querySelector('#view'); return {
      title: document.querySelector('#pageTitle').innerText, len: view.innerText.trim().length }; })()`);
    console.log(`\n── ${label} ──`);
    check(`标题为「${label}」`, info.title === label, info.title);
    check("有实际内容（非空白）", info.len > 30, info);
    await shot(`0${i + 1}-${v}`);
    i++;
  }

  console.log("\n── 合同详情抽屉 ──");
  await ev(`document.querySelector('#nav a[data-v="contracts"]').click()`);
  await sleep(1200);
  const clicked = await ev(`(() => { const el = document.querySelector('[onclick*="openContract"]'); if (!el) return 'no-trigger'; el.click(); return 'clicked'; })()`);
  await sleep(1600);
  check("列表里有合同入口", clicked === "clicked", clicked);
  const drawer = await ev(`(() => { const d = document.querySelector('#drawer'); return {
    on: d.classList.contains('on'), len: document.querySelector('#drawerBody').innerText.trim().length }; })()`);
  check("抽屉已打开且有内容", drawer.on && drawer.len > 100, drawer);
  check("合同正文已渲染（含条款）", (await ev(`document.querySelector('#drawerBody').innerText.includes('第一条')`)) === true);
  await shot("09-drawer");
  await ev(`document.querySelector('#drawer button.ghost').click()`);
  await sleep(600);

  console.log("\n── 智能助手（未配 Key，应确定性回答指标）──");
  await ev(`document.querySelector('#nav a[data-v="assistant"]').click()`);
  await sleep(1500);
  const sent = await ev(`(() => { const i = document.querySelector('#input'); if (!i) return 'no-input';
    i.value = '本月签了多少合同'; document.querySelector('#send').click(); return 'sent'; })()`);
  await sleep(3000);
  check("助手输入可用", sent === "sent", sent);
  const chat = await ev(`document.querySelector('#msgs') ? document.querySelector('#msgs').innerText.trim().slice(-300) : 'no-msgs'`);
  check("给出回答（固定口径不依赖模型）", typeof chat === "string" && /签约数|份/.test(chat), chat);
  check("回答带口径说明", /口径/.test(chat || ""), chat);
  await shot("10-assistant");

  console.log("\n── 设置页 ──");
  await ev(`document.querySelector('#nav a[data-v="settings"]').click()`);
  await sleep(1500);
  const cfg = await ev(`(() => ({ key: !!document.querySelector('#cfgKey'), model: !!document.querySelector('#cfgModel'),
    mask: (document.querySelector('#keyMask') || {}).innerText,
    exports: document.querySelectorAll('[onclick*="dlLedger"],[onclick*="dlBackup"]').length }))()`);
  check("Key 输入框存在", cfg.key === true, cfg);
  check("Key 状态提示已显示", typeof cfg.mask === "string" && cfg.mask.length > 0, cfg);
  check("导出/备份按钮 4 个", cfg.exports === 4, cfg);
  check("无页面内错误（全程）", (await ev(`JSON.stringify(window.__errs)`)) === "[]", await ev(`JSON.stringify(window.__errs)`));

  console.log("\n── CDP 层捕获 ──");
  const real = errors.filter((e) => !/favicon/i.test(e));
  console.log(real.length ? "  " + real.join("\n  ") : "  （无）");

  console.log(`\n================ 通过 ${pass} 项，失败 ${fail} 项 ================`);
  console.log(`截图：${OUT}-*.png`);
  if (fail || real.length) process.exitCode = 1;
  ws.close();
} catch (e) {
  console.error("验证失败:", e.message);
  console.error(chromeErr.slice(-1500));
  process.exitCode = 1;
} finally {
  chrome.kill("SIGKILL");
  await sleep(300);
}
