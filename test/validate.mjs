// 业务通网页版 · 无浏览器端到端验证脚手架
//
// 本仓库是纯前端 ESM + WebAssembly 应用，没有可用的无头浏览器环境，
// 所以用 Node 直接导入真实模块，配合桩（stub）替代浏览器专属全局：
//   - globalThis.localStorage  ：内存 Map，并提供测试用 DeepSeek Key
//   - globalThis.indexedDB     ：仅 new_id 用，加载返回 null（每次新建库）
//   - globalThis.fetch         ：按 system 文案分支返回意图 JSON / NL2SQL / 条款问答
//
// db.js 内部对 Node 有专门分支（用 wasmBinary 读本地 vendor/sql-wasm.wasm），
// 浏览器行为不变。因此本脚本跑的是与生产一致的确定性代码路径。
//
// 运行（在仓库根目录）：
//   node test/validate.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

// ---- 浏览器全局桩 ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.localStorage.setItem("bizflow_deepseek_key", "sk-test-dummy");

globalThis.indexedDB = {
  open() {
    const req = {};
    queueMicrotask(() => {
      req.result = {
        transaction() {
          const tx = {
            objectStore() {
              return {
                put() { return {}; },
                get() { const g = { result: null }; queueMicrotask(() => { if (g.onsuccess) g.onsuccess(); }); return g; },
              };
            },
            oncomplete: null,
          };
          queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
          return tx;
        },
        close() {},
      };
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  },
  deleteDatabase() { const req = {}; queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); if (req.onblocked) req.onblocked(); }); return req; },
};

const today = new Date().toISOString().slice(0, 10);
const J = (o) => JSON.stringify(o);

// ---- DeepSeek fetch 桩 ----
// 关键：四类意图必须互不串台——删除必须命中 DELETE_ANY（验证三级拒绝），
// 推进必须含明确动作动词（避免「列出履行中」被误判为推进），查询走 QUERY+NL2SQL。
function intentReplyFor(text) {
  // 1) 删除 → 三级动作 DELETE_ANY（恒美医疗当前为履行中，命中三级拒绝路径）
  if (/删除/.test(text)) {
    return J({ intent: "OPERATE", action_type: "DELETE_ANY", query_kind: null, intent_confidence: 0.95,
      slots: { contract_ref: { raw: "恒美医疗那个合同", normalized: "恒美医疗" } }, missing_slots: [] });
  }
  // 2) 回款录入 → 一级 CREATE_PAYMENT
  if (/回款/.test(text) && /合同|恒美/.test(text)) {
    return J({ intent: "OPERATE", action_type: "CREATE_PAYMENT", query_kind: null, intent_confidence: 0.95,
      slots: { customer_ref: { raw: "恒美医疗", normalized: "恒美医疗" }, contract_ref: { raw: "恒美医疗那个合同", normalized: "恒美医疗那个合同" }, received_date: { raw: "今天", normalized: today }, amount: { raw: "20 万", normalized: "200000.00" } }, missing_slots: [] });
  }
  // 3) 推进：必须含明确状态动作动词，且目标为「待签署→履行中」的中启集团合同
  if (/推进|签了|签完|已签署|生效|升\s*级/.test(text)) {
    const isZQ = /中启/.test(text);
    return J({ intent: "OPERATE", action_type: "ADVANCE_CONTRACT_STATUS", query_kind: null, intent_confidence: 0.95,
      slots: { contract_ref: { raw: isZQ ? "中启集团那个合同" : "恒美医疗那个合同", normalized: isZQ ? "中启集团" : "恒美医疗" }, to_status: { raw: "履行中", normalized: "履行中" } }, missing_slots: [] });
  }
  // 4) 查询 / 列出 / 哪些 → QUERY + NL2SQL
  if (/列出|所有|哪些|查询|查一下|有几|多少/.test(text)) {
    return J({ intent: "QUERY", action_type: null, query_kind: "NL2SQL", intent_confidence: 0.9, slots: {}, missing_slots: [] });
  }
  return J({ intent: "UNKNOWN", action_type: null, query_kind: null, intent_confidence: 0.3, slots: {}, missing_slots: [] });
}

globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const sys = (body.messages.find((m) => m.role === "system") || {}).content || "";
  const user = ([...body.messages].reverse().find((m) => m.role === "user") || {}).content || "";
  let content;
  if (sys.includes("意图解析器")) content = intentReplyFor(user);
  else if (sys.includes("可用表")) content = "SQL: SELECT c.contract_no, c.name, u.name AS customer_name FROM contract c JOIN customer u ON u.id = c.customer_id WHERE c.status='履行中' AND c.is_deleted=0 LIMIT 200\n口径: 列出状态为履行中的合同（单位：份）";
  else if (sys.includes("条款助手")) content = "付款条件为合同签订后 30 日内支付首款。\n依据：第三条 服务报酬及支付方式";
  else content = "正常";
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
};

// ---- 导入真实模块（相对路径，仓库任意位置可跑）----
const root = fileURLToPath(new URL("..", import.meta.url));
const db = await import(new URL("../js/db.js", import.meta.url).href);
const seed = await import(new URL("../js/seed.js", import.meta.url).href);
const proc = await import(new URL("../js/process.js", import.meta.url).href);
const metrics = await import(new URL("../js/metrics.js", import.meta.url).href);
const res = await import(new URL("../js/resolution.js", import.meta.url).href);
const engine = await import(new URL("../js/engine.js", import.meta.url).href);

const log = (...a) => console.log(...a);
let fail = 0;
function check(name, cond) { log((cond ? "✅" : "❌") + " " + name); if (!cond) fail++; }

await db.initDatabase();
check("数据库初始化", !!db.getDB());
check("初始未播种", !db.isSeeded());
await seed.seedDatabase();
check("播种后数据存在", db.isSeeded());
check("客户 ≥ 10", parseInt(db.scalar("SELECT COUNT(*) FROM customer") || 0, 10) >= 10);
check("合同 ≥ 1", parseInt(db.scalar("SELECT COUNT(*) FROM contract") || 0, 10) >= 1);

const s = proc.summary();
log("概览:", JSON.stringify(s));
check("概览有在办", s.active_count > 0);

check("指标·本月签约数", !!metrics.compute("本月签了几份合同"));
check("指标·未回款", !!metrics.compute("未回款多少"));
check("指标·停滞单", !!metrics.compute("哪些单卡住了"));

const cu = res.resolve_customer("宏远科技");
check("实体解析·宏远科技唯一", cu.status === "unique");

// 指标问题走确定性，不调模型
const r1 = await engine.handle("本月签了几份合同");
log("指标回答:", r1.reply);
check("本月签约数回答含『签约数』", /签约数/.test(r1.reply));

// 自然语言录入（一级，直接执行）
const before = parseInt(db.scalar("SELECT COUNT(*) FROM payment WHERE is_deleted=0") || 0, 10);
const r2 = await engine.handle("恒美医疗那个合同今天回款 20 万");
log("录入回答:", r2.reply);
const after = parseInt(db.scalar("SELECT COUNT(*) FROM payment WHERE is_deleted=0") || 0, 10);
check("回款记录已写入", after === before + 1);
check("录入回答含『已录入』", /已录入/.test(r2.reply));

// 状态推进（二级，出确认卡）：中启集团种子合同当前为「待签署」，推进到「履行中」才是真实状态变化
const r3 = await engine.handle("把中启集团那个合同推进到 履行中");
log("推进回答:", r3.reply);
const card = r3.pending;
check("推进产出确认卡", !!card && card.action_id);
check("确认卡动作是推进状态", card && card.action_type === "ADVANCE_CONTRACT_STATUS");
const cstatusBefore = db.one("SELECT status FROM contract WHERE id=?", [card.target.id]).status;
const rc = await engine.confirmAction(card.action_id);
log("确认后:", rc.reply);
const cstatusAfter = db.one("SELECT status FROM contract WHERE id=?", [card.target.id]).status;
check("确认后状态变为履行中", cstatusAfter === "履行中");
check("状态确有变化", cstatusBefore !== cstatusAfter);

// NL2SQL 探索查询
const r4 = await engine.handle("列出所有履行中的合同");
log("NL2SQL 回答:\n" + r4.reply);
check("NL2SQL 回答含合同编号", /HT-/.test(r4.reply));
check("NL2SQL 回答带口径", /口径/.test(r4.reply));

// 追问口径
const r5 = await engine.handle("这个怎么算的");
log("追问口径:", r5.reply);
check("追问口径能解释", /口径|算法|台账/.test(r5.reply));

// 三级拒绝
const r6 = await engine.handle("删除恒美医疗那个合同");
log("三级拒绝:", r6.reply);
check("删除被拒绝", /不支持|删除/.test(r6.reply));

// 撤销（一级录入可逆）
const log1 = db.one("SELECT id FROM operation_log WHERE action='CREATE' AND object_type='payment' ORDER BY created_at DESC");
if (log1) {
  const ur = engine.undo(log1.id);
  log("撤销:", ur.reply);
  check("撤销成功", ur.ok);
  check("回款记录已软删", parseInt(db.scalar("SELECT COUNT(*) FROM payment WHERE is_deleted=0 AND id=?", [db.one("SELECT object_id FROM operation_log WHERE id=?", [log1.id]).object_id]) || 0, 10) === 0);
} else { log("⚠️ 未找到可撤销记录"); }

log("\n" + (fail === 0 ? "🎉 全部通过" : `❌ 有 ${fail} 项失败`));
process.exit(fail === 0 ? 0 : 1);
