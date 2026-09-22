// api_test.mjs — 纯前端版的端到端验证（Node 环境下跑真实的 js/*.js 模块）。
//
// 为什么这么做：这个项目没有可用的无头浏览器，而全部业务逻辑都在浏览器 JS 里。
// 所以这里用桩替代浏览器全局（localStorage / IndexedDB / fetch / document），
// 直接 import 真实模块，把 59 个 /api/v1 接口逐个走一遍。
//
// 运行：node test/api_test.mjs
const t0 = Date.now();

// ---------------- 浏览器全局桩 ----------------
const LS = new Map();
globalThis.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => LS.set(k, String(v)),
  removeItem: (k) => LS.delete(k),
};

// 极简 IndexedDB：只实现本项目用到的 open / transaction / objectStore / get / put / deleteDatabase
function makeIDB() {
  const dbs = new Map();
  const ensure = (n) => { if (!dbs.has(n)) dbs.set(n, new Map()); return dbs.get(n); };
  const storeMap = (n, s) => { const d = ensure(n); if (!d.has(s)) d.set(s, new Map()); return d.get(s); };
  return {
    open(name) {
      const req = { result: null };
      const handle = {
        objectStoreNames: { contains: (s) => ensure(name).has(s) },
        createObjectStore: (s) => { storeMap(name, s); return {}; },
        close() {},
        transaction(_s, _mode) {
          const tx = { oncomplete: null, onerror: null, onabort: null };
          setTimeout(() => { try { tx.oncomplete && tx.oncomplete(); } catch {} }, 0);
          tx.objectStore = (sn) => {
            const m = storeMap(name, sn);
            return {
              put: (v, k) => { m.set(k, v); },
              get: (k) => {
                const r = { result: m.has(k) ? m.get(k) : null, onsuccess: null, onerror: null };
                setTimeout(() => { try { r.onsuccess && r.onsuccess(); } catch {} }, 0);
                return r;
              },
            };
          };
          return tx;
        },
      };
      req.result = handle;
      setTimeout(() => {
        try { req.onupgradeneeded && req.onupgradeneeded(); } catch {}
        try { req.onsuccess && req.onsuccess(); } catch {}
      }, 0);
      return req;
    },
    deleteDatabase(name) {
      dbs.delete(name);
      const req = { onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => { try { req.onsuccess && req.onsuccess(); } catch {} }, 0);
      return req;
    },
  };
}
globalThis.indexedDB = makeIDB();

// document.stubs：下载与打印页会用到
const created = [];
globalThis.document = {
  createElement: () => ({
    style: {}, download: "", href: "", setAttribute() {}, click() {}, remove() {},
  }),
  body: { appendChild: (el) => created.push(el) },
};
globalThis.URL.createObjectURL = () => "blob:stub";
globalThis.URL.revokeObjectURL = () => {};

// DeepSeek fetch 桩：按 system 提示词分流
globalThis.fetch = async (url, opt) => {
  const body = JSON.parse(opt.body);
  const sys = (body.messages[0] && body.messages[0].content) || "";
  const last = [...body.messages].reverse().find((m) => m.role === "user");
  const text = last ? String(last.content) : "";
  let content;
  if (sys.includes("意图解析器")) content = intentJson(text);
  else if (sys.includes("可用表（只读")) content = nl2sqlText(text);
  else if (sys.includes("合同条款助手")) content = "签订后 30 日内支付 30%，验收后 60 日内支付 70%。\n依据：3.2 支付方式：签订后 30 日内支付 30%";
  else content = "正常";
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
};

function intentJson(text) {
  const P = (o) => JSON.stringify({ query_kind: null, intent_confidence: 0.95, slots: {}, missing_slots: [], ...o });
  if (/删除|删掉/.test(text)) return P({ intent: "OPERATE", action_type: "DELETE_ANY" });
  if (/回款/.test(text) && /(万|元)/.test(text)) {
    const no = (text.match(/HT-\d{8}-\d{3}/) || [])[0] || text;
    return P({ intent: "OPERATE", action_type: "CREATE_PAYMENT", slots: {
      contract_ref: { raw: no, normalized: no },
      received_date: { raw: "今天", normalized: today() },
      amount: { raw: "20 万", normalized: "200000.00" } } });
  }
  if (/付款条件|怎么约定|条款/.test(text)) return P({ intent: "QUERY", query_kind: "CONTRACT_QA" });
  if (/签署|签了|推进/.test(text)) {
    return P({ intent: "OPERATE", action_type: "ADVANCE_CONTRACT_STATUS", slots: {
      contract_ref: { raw: "中启集团", normalized: "中启集团" },
      to_status: { raw: "履行中", normalized: "履行中" } } });
  }
  if (/哪些|列出|几家|多少|统计/.test(text)) return P({ intent: "QUERY", query_kind: "NL2SQL" });
  return P({ intent: "UNKNOWN" });
}
function nl2sqlText() {
  return "SQL: SELECT id, contract_no, name, status FROM contract WHERE status='履行中' AND is_deleted=0 LIMIT 50\n"
    + "口径: 按合同状态字段为「履行中」统计，不含已归档与已作废的合同";
}
function today() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------- 断言 ----------------
let pass = 0, fail = 0;
const fails = [];
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; fails.push(label); console.log(`  ❌ ${label}${extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 240) : ""}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// ---------------- 主流程 ----------------
const db = await import("../js/db.js");
const seed = await import("../js/seed.js");
const api = await import("../js/api.js");
const AI = await import("../js/ai.js");
const catalog = await import("../js/catalog.js");

const call = (p, opt = {}) => api.apiLocal(p, opt);

console.log("=== 纯前端版端到端验证 ===\n");

section("初始化与演示素材");
await db.initDatabase();
const stat = seed.seedDatabase();
check("客户 10 家", stat.customers === 10, stat);
check("报价单 13 份", stat.quotations === 13, stat);
check("合同 11 份", stat.contracts === 11, stat);
check("模板 5 个", stat.templates === 5, stat);
check("操作人 2 名", stat.operators === 2, stat);
check("提醒已生成（8 类扫描跑通）", stat.reminders > 0, stat.reminders);
check("库内合同数一致", parseInt(db.scalar("SELECT COUNT(*) FROM contract"), 10) === 11);

section("设置 / 操作人");
const health = await call("health");
check("health 返回 up", health.status === "up" && health.operator === "浩然", health);
const settings = await call("settings");
check("settings 带指标口径表", Object.keys(settings.metrics).length >= 5, Object.keys(settings.metrics));
check("settings 带动作三级分级", Object.values(settings.actions).some(a => a.level === 3), Object.keys(settings.actions).length);
const ops = await call("operators");
check("操作人 2 条", ops.length === 2, ops.map(o => o.name));
await call("settings/current-operator", { method: "POST", body: { operator_id: ops[1].id } });
check("切换操作人生效", db.current_operator_id() === ops[1].id);
await call("settings/current-operator", { method: "POST", body: { operator_id: ops[0].id } });
const created2 = await call("operators", { method: "POST", body: { name: "测试员" } });
check("新增操作人", !!created2.id);
let dupErr = null;
try { await call("operators", { method: "POST", body: { name: "测试员" } }); } catch (e) { dupErr = e; }
check("重名操作人被拒绝（40901）", dupErr && dupErr.code === 40901, dupErr && dupErr.code);
await call(`operators/${created2.id}`, { method: "DELETE" });
check("删除无历史记录的操作人成功", !db.one("SELECT id FROM operator WHERE id=? AND is_deleted=0", [created2.id]));
const thRes = await call("settings", { method: "PATCH", body: { stagnation_threshold: { signing_days: 20, acceptance_days: 30, invoice_days: 30, delivery_days: 30 } } });
check("PATCH settings 返回 updated", thRes.updated.includes("stagnation_threshold"));

section("客户");
const custPage = await call("customers?page_size=100");
check("客户列表 10 条", custPage.total === 10, custPage.total);
check("客户列表含合同/报价计数", custPage.list[0].contract_count !== undefined, Object.keys(custPage.list[0]).slice(0, 8));
const kw = await call("customers?keyword=" + encodeURIComponent("恒美"));
check("关键词搜索命中 1 家", kw.total === 1 && kw.list[0].name.includes("恒美"), kw.total);
const custId = custPage.list.find(c => c.name.includes("恒美")).id;
const custDetail = await call(`customers/${custId}`);
check("客户详情含合同/报价/金额汇总", !!custDetail.customer && custDetail.contracts.length > 0 && !!custDetail.amount, Object.keys(custDetail));
check("金额汇总为字符串金额", typeof custDetail.amount.contract_total === "string", custDetail.amount);
const newCust = await call("customers", { method: "POST", body: { name: "测试客户甲", contact_name: "张三", contact_phone: "13900000000" } });
check("新建客户返回 id", !!newCust.id);
await call(`customers/${newCust.id}`, { method: "PATCH", body: { contact_name: "李四" } });
check("PATCH 客户生效", db.one("SELECT contact_name FROM customer WHERE id=?", [newCust.id]).contact_name === "李四");
await call(`customers/${newCust.id}`, { method: "DELETE" });
check("软删客户成功", db.one("SELECT is_deleted FROM customer WHERE id=?", [newCust.id]).is_deleted === 1);
let delUsed = null;
try { await call(`customers/${custId}`, { method: "DELETE" }); } catch (e) { delUsed = e; }
check("有关联数据的客户不可删（40903）", delUsed && delUsed.code === 40903, delUsed && delUsed.code);

section("报价单");
const qPage = await call("quotations?page_size=100");
check("报价单 13 份", qPage.total === 13, qPage.total);
const qDraft = qPage.list.find(q => q.status === "已发出");
const qDetail = await call(`quotations/${qDraft.id}`);
check("报价详情含明细/版本/可推进状态", qDetail.items.length > 0 && qDetail.versions.length > 0 && qDetail.allowed_transitions.length > 0, Object.keys(qDetail));
const newQ = await call("quotations", { method: "POST", body: { customer_id: custId, payment_terms: "验收后一次性支付", items: [{ name: "测试服务", spec: "一次性", quantity: "1", unit_price: "10000.00", amount: "10000.00" }] } });
check("新建报价单自动生成编号", /^BJ-\d{8}-\d{3}$/.test(newQ.quotation_no), newQ.quotation_no);
check("未传金额时按明细合计", db.one("SELECT amount FROM quotation WHERE id=?", [newQ.id]).amount === "10000.00", db.one("SELECT amount FROM quotation WHERE id=?", [newQ.id]).amount);
const st1 = await call(`quotations/${newQ.id}/status-transitions`, { method: "POST", body: { to_status: "已发出" } });
check("状态推进 草稿→已发出", st1.status === "已发出", st1);
let badTrans = null;
try { await call(`quotations/${newQ.id}/status-transitions`, { method: "POST", body: { to_status: "已转合同" } }); } catch (e) { badTrans = e; }
check("非法跳转被拒（40301）", badTrans && badTrans.code === 40301, badTrans && badTrans.code);
const st2 = await call(`quotations/${newQ.id}/status-transitions`, { method: "POST", body: { to_status: "已确认" } });
check("状态推进 已发出→已确认", st2.status === "已确认", st2);

section("报价转合同");
const conv = await call(`quotations/${newQ.id}/convert-to-contract`, { method: "POST", body: {} });
check("转合同返回合同编号", /^HT-\d{8}-\d{3}$/.test(conv.contract_no), conv);
check("明细已复制", conv.items_copied === 1, conv.items_copied);
check("来源报价单状态变「已转合同」", db.one("SELECT status FROM quotation WHERE id=?", [newQ.id]).status === "已转合同");

section("合同");
const cPage = await call("contracts?page_size=100");
check("在管合同 11 份（10 演示 + 1 新建；已到期那份已归档不计入）", cPage.total === 11, cPage.total);
check("合同列表带回款汇总", !!cPage.list[0].amount_summary, Object.keys(cPage.list[0]).slice(0, 5));
const cBig = cPage.list.find(c => parseInt(c.amount, 10) > 1000000 && c.status === "履行中");
const cDetail = await call(`contracts/${cBig.id}`);
const needKeys = ["contract", "items", "payment_plans", "versions", "current_version", "attachments", "deliveries", "acceptances", "invoices", "payments", "status_logs", "amount_summary", "process_stage", "allowed_transitions", "source_quotation"];
check("合同详情字段齐全", needKeys.every(k => k in cDetail), needKeys.filter(k => !(k in cDetail)));
check("合同正文已生成（版本 V1.0）", (cDetail.current_version.content || "").includes("第一条 服务内容"), (cDetail.current_version.content || "").slice(0, 40));
check("付款计划已核销（有计划与状态）", cDetail.payment_plans.length > 0 && cDetail.payment_plans[0].status, cDetail.payment_plans);
check("业务进程阶段已推导", !!cDetail.process_stage.current_stage, cDetail.process_stage.current_stage);
const vNew = await call(`contracts/${cBig.id}/versions`, { method: "POST", body: { content: "新版正文", change_summary: "测试" } });
check("新建版本号自增到 V1.1", vNew.version_no === "V1.1", vNew);
const logs = await call(`contracts/${cBig.id}/status-logs`);
check("推进记录带操作人姓名", logs.length > 0 && logs[0].operator_name, logs.length);
await call(`contracts/${cBig.id}/archive`, { method: "POST" });
check("归档标记生效", db.one("SELECT is_archived FROM contract WHERE id=?", [cBig.id]).is_archived === 1);
await call(`contracts/${cBig.id}/archive`, { method: "DELETE" });
check("取消归档生效", db.one("SELECT is_archived FROM contract WHERE id=?", [cBig.id]).is_archived === 0);
const archivedPage = await call("contracts?is_archived=true&page_size=100");
check("归档列表可单独查询（已到期合同 1 份）", archivedPage.total === 1, archivedPage.total);

section("付款计划");
const planRes = await call(`contracts/${cBig.id}/payment-plans`, { method: "POST", body: { seq_no: 9, plan_amount: "1000.00", due_date: "2026-12-31" } });
check("新增付款计划并返回核销表", planRes.plans.length >= 2, planRes.plans.length);
const planId = planRes.plans.find(p => p.seq_no === 9).id;
await call(`payment-plans/${planId}`, { method: "DELETE" });
check("删除付款计划成功", !db.one("SELECT id FROM contract_payment_plan WHERE id=? AND is_deleted=0", [planId]));

section("履约记录（交付 / 验收 / 开票 / 回款）");
const dRes = await call(`contracts/${cBig.id}/deliveries`, { method: "POST", body: { content: "测试交付物", quantity: "1", ship_date: today() } });
check("新建交付记录（默认待签收）", !!dRes.id && db.one("SELECT receipt_status FROM delivery WHERE id=?", [dRes.id]).receipt_status === "待签收");
await call(`deliveries/${dRes.id}`, { method: "PATCH", body: { receipt_status: "已签收", receipt_date: today() } });
check("PATCH 交付记录生效", db.one("SELECT receipt_status FROM delivery WHERE id=?", [dRes.id]).receipt_status === "已签收");
const aRes = await call(`contracts/${cBig.id}/acceptances`, { method: "POST", body: { accept_date: today(), result: "通过" } });
check("新建验收记录", !!aRes.id);
const iRes = await call(`contracts/${cBig.id}/invoices`, { method: "POST", body: { invoice_no: "TEST0001", invoice_date: today(), amount: "1000.00" } });
check("新建开票记录", !!iRes.id);
const before = db.amount_summary(cBig.id);
const pRes = await call(`contracts/${cBig.id}/payments`, { method: "POST", body: { received_date: today(), amount: "5000.00", serial_no: "SNTEST" } });
check("新建回款返回核销与汇总", !!pRes.allocation && !!pRes.amount_summary, Object.keys(pRes));
const after = db.amount_summary(cBig.id);
check("回款后已回款额增加", db.to_cents(after.paid_amount) - db.to_cents(before.paid_amount) === 500000, [before.paid_amount, after.paid_amount]);
let missReq = null;
try { await call(`contracts/${cBig.id}/payments`, { method: "POST", body: { remark: "缺金额" } }); } catch (e) { missReq = e; }
check("缺必填字段被拒（40002）", missReq && missReq.code === 40002, missReq && missReq.code);
await call(`payments/${pRes.id}`, { method: "DELETE" });
check("删除回款记录（软删）", db.one("SELECT is_deleted FROM payment WHERE id=?", [pRes.id]).is_deleted === 1);

section("模板库");
const tpls = await call("templates");
check("模板 5 个且变量已解析为数组", tpls.total === 5 && Array.isArray(tpls.list[0].variables), tpls.total);
const tplTypes = await call("templates/types");
check("模板类型枚举（含 doc_kinds）", tplTypes.types.includes("报价单") && tplTypes.doc_kinds.includes("盖章扫描件"), tplTypes);
const tplDetail = await call(`templates/${tpls.list[0].id}`);
check("模板详情含正文", (tplDetail.content || "").length > 20, (tplDetail.content || "").slice(0, 30));
const pv = await call(`templates/${tpls.list[0].id}/parse-variables`, { method: "POST", body: { content: "{{客户名称}} {{明细表}} {{不存在的变量}}" } });
check("变量解析区分已知/未知", pv.variables.length === 2 && pv.unknown.length === 1, pv);

section("业务进程");
const procs = await call("processes");
check("进程看板 7 个阶段列", Object.keys(procs.board).length === 7, Object.keys(procs.board));
check("进程列表非空且带停滞判定", procs.list.length > 0 && procs.list[0].is_stagnant !== undefined, procs.total);
check("概览统计齐备", "active_count" in procs.summary && "unpaid_total" in procs.summary, procs.summary);
const procDetail = await call(`processes/${procs.list[0].process_id}`);
check("进程详情含时间线与合同号", !!procDetail.timeline && "contract_id" in procDetail, Object.keys(procDetail));
const stagnant = await call("processes?stagnant_only=true");
check("仅看停滞可用", stagnant.list.every(p => p.is_stagnant), stagnant.total);

section("提醒");
const rem = await call("reminders");
check("提醒列表带关联对象（客户名/编号）", rem.list.length > 0 && rem.list[0].customer_name !== undefined, rem.list.length);
check("未读数已统计", typeof rem.unread === "number", rem.unread);
const remTypes = new Set(rem.list.map(r => r.remind_type));
check("覆盖多类提醒（≥3 类）", remTypes.size >= 3, [...remTypes]);
const unreadOne = rem.list.find(r => !r.is_read);
if (unreadOne) { await call(`reminders/${unreadOne.id}/read`, { method: "PATCH" }); check("单条已读", db.one("SELECT is_read FROM reminder WHERE id=?", [unreadOne.id]).is_read === 1); }
await call("reminders/read-all", { method: "POST" });
check("全部已读", parseInt(db.scalar("SELECT COUNT(*) FROM reminder WHERE is_read=0"), 10) === 0);
const scanRes = await call("reminders/scan", { method: "POST" });
check("重新扫描返回 5 项调度结果", "reminder_scan" in scanRes && "process_snapshot" in scanRes, Object.keys(scanRes));

section("附件（浏览器存储）");
const fakeFile = (name, bytes) => ({ name, arrayBuffer: async () => new Uint8Array(bytes).buffer });
const imp = await api.importScans("CONTRACT", cBig.id, "盖章扫描件", null, [fakeFile("盖章件.pdf", [1, 2, 3, 4])]);
check("导入扫描件成功", imp.count === 1, imp);
const att = db.one("SELECT * FROM attachment WHERE object_id=? AND is_deleted=0", [cBig.id]);
check("附件记录已落库（含分类与大小）", att && att.doc_kind === "盖章扫描件" && att.file_size === 4, att);
const bad = await api.importScans("CONTRACT", cBig.id, "盖章扫描件", null, [fakeFile("病毒.exe", [1])]);
check("不支持的格式被拒", bad.count === 0 && bad.rejected.length === 1, bad.rejected);
await api.downloadAttachment(att.id);
check("下载附件触发浏览器下载", created.length > 0);
await api.deleteAttachment(att.id);
check("删除附件（软删）", db.one("SELECT is_deleted FROM attachment WHERE id=?", [att.id]).is_deleted === 1);
let badAdv = null;
try { await api.importScans("CONTRACT", cBig.id, "盖章扫描件", "待签署", [fakeFile("x.pdf", [1])]); } catch (e) { badAdv = e; }
check("非法推进目标被拒（40301）", badAdv && badAdv.code === 40301, badAdv && badAdv.code);

section("文档导出");
const docxBytes = (await import("../js/docs.js")).to_docx("测试", [{ type: "p", text: "正文" }]);
check("docx 是合法 ZIP（PK 魔术字）", docxBytes[0] === 0x50 && docxBytes[1] === 0x4b, [docxBytes[0], docxBytes[1]]);
check("docx 体积合理（含 4 个部件）", docxBytes.length > 800, docxBytes.length);
const qBlocks = (await import("../js/docs.js")).quotation_blocks(qDetail.quotation, null);
check("报价单 blocks 含标题/明细表/付款条件", qBlocks.some(b => b.type === "title") && qBlocks.some(b => b.type === "table"), qBlocks.map(b => b.type));
const cBlocks = (await import("../js/docs.js")).contract_blocks(cDetail.contract, "V1.0");
check("合同 blocks 由正文解析而来（八条 + 明细表）", cBlocks.filter(b => b.type === "p").length >= 8 && cBlocks.some(b => b.type === "table"), cBlocks.map(b => b.type).join(","));
const html = (await import("../js/docs.js")).to_print_html("测试", qBlocks, "提示");
check("打印页 HTML 含打印按钮", html.includes("window.print()") && html.includes("<!DOCTYPE html>"), html.length);

section("台账导出 / 备份");
const n0 = created.length;
api.exportLedger("contract");
api.exportBackup();
check("CSV + JSON 备份均触发下载", created.length === n0 + 2, created.length - n0);

section("智能助手（三级授权闸门）");
const chConv = await call("assistant/conversations", { method: "POST", body: { title: "验证" } });
check("创建会话", !!chConv.id);
AI.setApiKey("sk-test-key");
const m1 = await call(`assistant/conversations/${chConv.id}/messages`, { method: "POST", body: { content: "列出所有履行中的合同" } });
check("NL2SQL 查询返回明细与口径", /HT-\d{8}/.test(m1.reply) && /口径/.test(m1.reply), m1.reply.slice(0, 120));
check("查询结果带可点击实体", (m1.entities || []).length > 0, m1.entities && m1.entities.length);
const m2 = await call(`assistant/conversations/${chConv.id}/messages`, { method: "POST", body: { content: "这些数字的统计口径是什么" } });
check("口径可追问（命中追问）", /口径/.test(m2.reply), m2.reply.slice(0, 100));
const m3 = await call(`assistant/conversations/${chConv.id}/messages`, { method: "POST", body: { content: `${cBig.contract_no} 今天回款 20 万` } });
const resEvent = (m3.events || []).find(e => e.event === "result");
check("一级操作直接执行并可撤销", !!resEvent && resEvent.undoable === true, m3.reply.slice(0, 100));
check("一级操作回答带实体入口", (m3.entities || []).length > 0, m3.entities);
const m4 = await call(`assistant/conversations/${chConv.id}/messages`, { method: "POST", body: { content: "把中启集团那个合同推进到履行中" } });
const card = (m4.events || []).find(e => e.event === "confirm_card");
check("二级操作出确认卡（不落库）", !!card && !!card.action_id, m4.reply.slice(0, 90));
check("确认卡列出「现状值 → 新值」", !!card && (card.changes || []).length > 0, card && card.changes);
const cidMid = db.one("SELECT id, status FROM contract WHERE status='待签署' LIMIT 1");
const beforeStatus = cidMid.status;
check("确认卡未落库（状态未变）", db.one("SELECT status FROM contract WHERE id=?", [cidMid.id]).status === beforeStatus);
await call(`assistant/actions/${card.action_id}/cancel`, { method: "POST" });
check("取消确认卡后状态仍不变", db.one("SELECT status FROM contract WHERE id=?", [cidMid.id]).status === beforeStatus);
const m5 = await call(`assistant/conversations/${chConv.id}/messages`, { method: "POST", body: { content: "把中启集团那个合同推进到履行中" } });
const card2 = (m5.events || []).find(e => e.event === "confirm_card");
check("取消后可再次发起同一操作", !!card2 && !!card2.action_id, m5.reply.slice(0, 90));
const conf = await call(`assistant/actions/${card2.action_id}/confirm`, { method: "POST" });
check("确认后状态确有变化", db.one("SELECT status FROM contract WHERE id=?", [cidMid.id]).status !== beforeStatus, [beforeStatus, db.one("SELECT status FROM contract WHERE id=?", [cidMid.id]).status]);
const m6 = await call(`assistant/conversations/${chConv.id}/messages`, { method: "POST", body: { content: "删除恒美医疗那个合同" } });
check("三级操作被永久拒绝", (m6.events || []).some(e => e.event === "rejected"), m6.reply.slice(0, 110));
const m7 = await call(`assistant/conversations/${chConv.id}/messages`, { method: "POST", body: { content: `${cBig.contract_no} 的付款条件怎么约定` } });
const cite = (m7.events || []).find(e => e.event === "citation");
check("条款问答走合同正文并标注原文依据", !!cite && !!cite.excerpt && (m7.entities || []).some(e => e.type === "contract"), cite && cite.excerpt);
const msgs = await call(`assistant/conversations/${chConv.id}/messages`);
const withEnt = msgs.filter(m => { try { return m.payload && (JSON.parse(m.payload).entities || []).length; } catch { return false; } });
check("会话消息已持久化（含可点击实体）", msgs.length >= 14 && withEnt.length > 0, [msgs.length, withEnt.length]);
const pend = await call("assistant/pending-actions");
check("待确认动作可查询", Array.isArray(pend), pend.length);
const logsOps = await call("operation-logs?limit=50");
check("操作日志已留痕", logsOps.length > 0 && logsOps.some(l => l.operator_name), logsOps.length);
if (resEvent) {
  const un = await call(`assistant/actions/${resEvent.log_id}/undo`, { method: "POST" });
  check("撤销一级操作成功", un.ok !== false, un.reply && un.reply.slice(0, 60));
}

section("无 Key 时的降级");
AI.setApiKey("");
LS.delete("sk-test-key");
const m8 = await call(`assistant/conversations/${chConv.id}/messages`, { method: "POST", body: { content: "恒美医疗最近怎么样" } }).catch(e => ({ reply: "ERROR:" + e.message }));
check("未配 Key 时给出可读提示（不崩）", /Key|模型|AI/.test(m8.reply || ""), (m8.reply || "").slice(0, 110));
const m9 = await call(`assistant/conversations/${chConv.id}/messages`, { method: "POST", body: { content: "本月签了多少合同" } }).catch(e => ({ reply: "ERROR:" + e.message }));
check("固定口径指标不依赖模型即可回答", /份/.test(m9.reply || ""), (m9.reply || "").slice(0, 80));
const t = await call("settings/ai/test", { method: "POST" });
check("自检正确报告未配置 Key", t.ok === false && t.stage === "配置", t);

console.log(`\n================ 结果 ================`);
console.log(`通过 ${pass} 项，失败 ${fail} 项，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (fail) { console.log("失败项：\n - " + fails.join("\n - ")); process.exitCode = 1; }
