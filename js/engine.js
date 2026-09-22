// engine.js — 意图 → 动作 的执行引擎（浏览器端确定性实现）。平移自 engine.py。
//
// 管线：
//   ① 意图识别 + 槽位抽取（LLM，ai.js）
//   ② 风险分级（本文件静态查表，模型无法影响）
//   ③ 实体解析（resolution.js）
//   ④ 槽位校验（本文件，重新计算 missing_slots，不信任模型）
//   ⑤ 执行：一级直接落库 / 二级出确认卡 / 三级直接拒绝
//
// 与后端差异：本文件用 db.* 命名空间直接操作 sql.js（无 conn 参数）；
// 会话历史与实体栈放在模块内存（单页应用内有效），确认卡临时存内存 _pending。
import * as db from "./db.js";
import * as catalog from "./catalog.js";
import * as ai from "./ai.js";
import * as answer from "./answer.js";
import * as metrics from "./metrics.js";
import * as proc from "./process.js";
import * as res from "./resolution.js";

const { ACTIONS, ACTION_ALIASES, TRANSITIONS, FIELD_LABELS, METRICS, NON_QUERYABLE } = catalog;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CANNOT_ANSWER_TIP =
  "这个问题我目前没法给出可靠答案，就不猜了。下面这些我一定能答准：\n" +
  "· 统计：本月签了多少合同 / 报价转化率是多少 / 未回款多少 / 本月开票金额\n" +
  "· 清单：哪些单卡住了 / 有哪些合同快到期 / 宏远科技有哪些合同\n" +
  "· 极值：最大客户是哪个 / 金额最小的合同是哪份\n" +
  "· 记录：宏远科技今天回款 20 万 / 蓝图软件昨天已开票 24 万\n" +
  "· 条款：这份合同的付款条件是什么（从合同详情页进入）";

function aiFailureReply(e) { return "AI 服务调用失败。台账、录入、提醒这些不依赖模型的功能不受影响。\n" + aiFailureHint(e); }
function aiFailureHint(e) {
  const s = `${e && e.name || ""}: ${e && e.message || e}`;
  const low = s.toLowerCase();
  if (["proxy", "connect", "timeout", "network", "dns", "refused", "failed to fetch", "networkerror"].some((w) => low.includes(w))) {
    return "看起来是网络或代理问题。请确认你的浏览器能直连 api.deepseek.com（纯前端版没有后端代理）。\n技术信息：" + s;
  }
  if (["401", "402", "403", "invalid api key", "authentication", "insufficient", "balance"].some((w) => low.includes(w))) {
    return "看起来是 API Key 的问题：无效、被吊销，或者余额不足。请到设置页检查 Key。\n技术信息：" + s;
  }
  if (s.includes("429") || low.includes("rate limit")) return "调用太频繁被限流了，稍等一会儿再试。\n技术信息：" + s;
  return "技术信息：" + s;
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const REF_SLOTS = new Set(["customer_ref", "contract_ref", "quotation_ref", "record_ref", "template_ref", "operator_ref"]);
export const UPDATABLE = {
  contract: ["name", "contract_type", "amount", "amount_type", "sign_date", "service_start_date",
    "service_end_date", "planned_delivery_date", "auto_renewal", "payment_terms", "remark"],
  customer: ["name", "credit_code", "contact_name", "contact_phone", "address", "invoice_title",
    "invoice_tax_no", "invoice_bank", "invoice_account", "remark"],
  quotation: ["amount", "valid_until", "payment_terms", "remark"],
  delivery: ["content", "quantity", "logistics_no", "receipt_status", "receipt_date", "remark"],
  acceptance: ["accept_date", "result", "remark"],
  invoice: ["invoice_no", "invoice_date", "amount", "receipt_status", "remark"],
  payment: ["received_date", "amount", "serial_no", "remark"],
};
const RECORD_TABLE = { delivery: "delivery", acceptance: "acceptance", invoice: "invoice", payment: "payment" };

// ---------------- 会话状态（模块内存） ----------------
let _history = [];   // [{role, content, payload}]
let _stack = [];     // [{type, id, label}]
let _pending = new Map(); // action_id -> {plan, op_id, createdAt}

export function getHistory() { return _history.slice(); }
export function resetSession() { _history = []; _stack = []; _pending.clear(); }
function _pushHistory(turn) { _history.push(turn); if (_history.length > 40) _history = _history.slice(-40); }
function _recordAssistant(r) {
  _pushHistory({ role: "assistant", content: r.reply || "", payload: JSON.stringify({ events: r.events || [], entities: r.entities || [] }) });
  if (r.entities && r.entities.length) _stack = res.push_entities(_stack, r.entities);
}

function ev(name, data = {}) { return { event: name, ...data }; }

function normalize_action(raw) {
  if (!raw) return null;
  let a = String(raw).trim().toUpperCase().replace(/\s+/g, "_").replace(/-/g, "_");
  if (ACTIONS[a]) return a;
  if (ACTION_ALIASES[a]) return ACTION_ALIASES[a];
  for (const pre of ["CREATE_", "UPDATE_", "ADD_", "RECORD_", "MODIFY_"]) {
    if (a.startsWith(pre) && ACTION_ALIASES[a.slice(pre.length)]) return ACTION_ALIASES[a.slice(pre.length)];
  }
  return null;
}

// ---------------- 槽位取值 ----------------
function _slot(parsed, name) {
  const s = (parsed.slots && parsed.slots[name]) || null;
  if (!s || typeof s !== "object") return null;
  return s.normalized != null ? s.normalized : s.raw;
}

function _norm_amount(v) {
  if (v == null || v === "") return null;
  let s = String(v).trim().replace(/,/g, "").replace(/[¥￥]/g, "").replace(/元/g, "");
  if (!AMOUNT_RE.test(s)) {
    const s2 = _cn_amount(s);
    if (s2 == null) return null;
    s = s2;
  }
  return db.fmt_money(db.to_cents(s));
}

function _cn_amount(s) {
  const CN = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "百": 100, "千": 1000, "万": 10000, "亿": 100000000 };
  const m = String(s).match(/^([零一二两三四五六七八九十百千万亿]+)元?$/);
  if (!m) return null;
  const txt = m[1];
  let total = 0, section = 0, num = 0;
  for (const ch of txt) {
    const v = CN[ch];
    if (v >= 10000) { section = (section + (num || 0)) * v; total += section; section = 0; num = 0; }
    else if (v >= 10) { section += (num || 1) * v; num = 0; }
    else num = v;
  }
  return String(total + section + num);
}

function _norm_date(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return DATE_RE.test(s) ? s : null;
}

// ---------------- 实体解析分发 ----------------
function _resolve_ref(name, raw, context, stack, contract_id) {
  if (name === "customer_ref" || name === "customer_name") return res.resolve_customer(String(raw || ""));
  if (name === "contract_ref") return res.resolve_contract(String(raw || ""), context, stack);
  if (name === "quotation_ref") return res.resolve_quotation(String(raw || ""), context, stack);
  if (name === "record_ref") return res.resolve_record(String(raw || ""), contract_id || "", (name === "record_ref" ? (context.record_table || "payment") : "payment"));
  if (name === "template_ref") return res.resolve_template(String(raw || ""));
  if (name === "operator_ref") return res.resolve_operator(String(raw || ""));
  return { status: "zero", candidates: [] };
}

// ---------------- 计划构建 ----------------
function build_plan(action_type, parsed, context, stack, op_id) {
  const spec = ACTIONS[action_type];
  context = context || {};

  if (_looks_batch(parsed, action_type)) {
    return { ok: false, reject: { code: 42203, message: "检测到多个对象，批量操作不支持通过对话执行。请逐个处理。", guide: "请到对应详情页逐条操作，或在对话中分别说明。" } };
  }

  const slots = {};
  const refs = {};
  const resolve_errors = [];

  for (const name of spec.required.concat(spec.optional)) {
    if (!REF_SLOTS.has(name)) continue;
    const raw = _slot(parsed, name);
    if (raw == null) continue;
    let cid = null;
    if (name === "record_ref") {
      const cr = _slot(parsed, "contract_ref");
      if (cr) { const rc = res.resolve_contract(String(cr), context, stack); cid = rc.id; }
    }
    const r = _resolve_ref(name, raw, context, stack, cid);
    if (r.status === "unique") refs[name] = r;
    else if (r.status === "multi") resolve_errors.push({ kind: "multi", slot: name, raw, candidates: r.candidates });
    else resolve_errors.push({ kind: "zero", slot: name, raw });
  }

  if (resolve_errors.length) {
    const first = resolve_errors[0];
    if (first.kind === "multi") {
      return { ok: false, clarify: { message: `「${first.raw}」匹配到 ${first.candidates.length} 个结果，请确认是哪一个：`, candidates: first.candidates, slot: first.slot, allow_create: false } };
    }
    return { ok: false, clarify: { message: `没有找到「${first.raw}」对应的${_slot_label(first.slot)}。是要新建，还是换个名称试试？`, options: [{ label: "重新输入名称", value: "@retry" }], slot: first.slot, allow_create: false } };
  }

  for (const name of spec.required.concat(spec.optional)) {
    if (REF_SLOTS.has(name) || name === "fields") continue;
    const v = _slot(parsed, name);
    if (v == null || v === "") continue;
    if (name === "amount" || name === "plan_amount") { const nv = _norm_amount(v); if (nv) slots[name] = nv; }
    else if (["ship_date", "receipt_date", "accept_date", "invoice_date", "received_date", "due_date", "sign_date", "service_start_date", "service_end_date", "planned_delivery_date", "valid_until"].includes(name)) { const nv = _norm_date(v); if (nv) slots[name] = nv; }
    else if (name === "to_status") { const tv = String(v).trim(); if (TRANSITIONS.CONTRACT[tv] || TRANSITIONS.QUOTATION[tv]) slots[name] = tv; }
    else if (name === "accept_result") slots[name] = ({ "通过": "通过", "合格": "通过", "过了": "通过", "不通过": "不通过", "不合格": "不通过", "待验收": "待验收" })[String(v).trim()] || String(v).trim();
    else if (name === "auto_renewal") slots[name] = typeof v === "boolean" ? v : ["是", "true", "需要", "要", "1"].includes(String(v).trim());
    else if (name === "seq_no") { const n = parseInt(String(v).replace(/\D/g, ""), 10); if (!isNaN(n)) slots[name] = n; }
    else slots[name] = v;
  }

  let missing = spec.required.filter((m) => !(m in slots) && !(m in refs));
  missing = missing.filter((m) => m !== "fields");

  if (action_type.startsWith("UPDATE_") && !("fields" in parsed.slots || (parsed.slots && parsed.slots.fields))) {
    // 模型没给 fields 时，missing 补上 fields，让后续追问
    const f = parsed.fields || (parsed.slots && parsed.slots.fields);
    if (f && typeof f === "object" && Object.keys(f).length) parsed.slots.fields = { raw: "", normalized: f };
    else missing.push("fields");
  }

  if (missing.length) return { ok: false, clarify: _clarify_for(missing, slots, refs) };

  const target = _target_of(action_type, slots, refs, spec);
  const plan = { action_type, level: spec.level, target, slots, refs: Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, { id: v.id, label: v.label }])), changes: [], impact: "" };
  return { ok: true, plan };
}

function _slot_label(slot) {
  return ({ customer_ref: "客户", contract_ref: "合同", quotation_ref: "报价单", record_ref: "记录", template_ref: "模板", operator_ref: "操作人" })[slot] || "对象";
}

function _looks_batch(parsed, action_type) {
  const slots = parsed.slots || {};
  for (const name of Object.keys(slots)) {
    if (!REF_SLOTS.has(name) || !slots[name] || typeof slots[name] !== "object") continue;
    const raw = String(slots[name].raw || "");
    if (/[、,，]|和|以及|都|全部|所有/.test(raw)) {
      if (action_type.startsWith("CREATE") || action_type.startsWith("UPDATE") || action_type.startsWith("ADVANCE") || action_type.startsWith("DELETE") || action_type.startsWith("ARCHIVE")) return true;
    }
  }
  return false;
}

function _clarify_for(missing, slots, refs) {
  const order = ["customer_ref", "contract_ref", "quotation_ref", "template_ref", "record_ref", "amount", "plan_amount", "received_date", "ship_date", "accept_date", "invoice_date", "due_date", "invoice_no", "content", "to_status", "accept_result", "seq_no", "service_start_date", "service_end_date", "report_template", "fields"];
  missing.sort((a, b) => (order.includes(a) ? order.indexOf(a) : 99) - (order.includes(b) ? order.indexOf(b) : 99));
  const first = missing[0];
  const label = ({ customer_ref: "哪个客户", contract_ref: "是哪份合同", quotation_ref: "哪份报价单", amount: "金额是多少", plan_amount: "这一期的金额是多少", received_date: "哪天到账的", ship_date: "哪天发货的", accept_date: "哪天验收的", invoice_date: "哪天开的票", due_date: "约定哪天回款", invoice_no: "发票号是多少", content: "交付了什么内容", to_status: "要推进到哪个状态", accept_result: "验收结果是什么", seq_no: "是第几期", service_start_date: "服务期从哪天开始", service_end_date: "服务期到哪天结束", report_template: "要出哪份报告", fields: "要改哪些内容", customer_name: "新客户叫什么名字" })[first] || `请补充${first}`;
  let hint = "";
  if (first === "to_status") hint = "可选：草稿 / 待签署 / 履行中 / 已到期 / 已终止 / 已作废";
  else if (first === "accept_result") hint = "可选：通过 / 不通过";
  else if (first === "report_template") hint = "可选：月度合同台账 / 回款情况 / 报价转化";
  const parsed_so_far = {};
  for (const k of ["amount", "received_date", "ship_date"]) if (k in slots) parsed_so_far[k] = slots[k];
  for (const k of Object.keys(refs)) parsed_so_far[k] = refs[k].label;
  return { message: `${label}？` + (hint ? `（${hint}）` : ""), missing_slots: missing, parsed_so_far, allow_create: false };
}

function _target_of(action_type, slots, refs, spec) {
  for (const key of ["contract_ref", "customer_ref", "quotation_ref", "template_ref"]) {
    if (key in refs) { const r = refs[key]; return { type: spec.object, id: r.id, label: r.label || "" }; }
  }
  if (slots.customer_name) return { type: "customer", id: null, label: slots.customer_name };
  return { type: spec.object, id: null, label: spec.label };
}

// ---------------- 确认卡 ----------------
function make_card(plan) {
  const at = plan.action_type;
  const { slots, refs, target } = plan;
  let changes = [];
  let impact = "";

  if (at === "ADVANCE_CONTRACT_STATUS") {
    const c = db.one("SELECT * FROM contract WHERE id = ?", [target.id]);
    changes = [{ field: "status", label: "状态", from: c.status, to: slots.to_status }];
    impact = _predict_stage_text(c.id, slots.to_status);
  } else if (at === "ADVANCE_QUOTATION_STATUS") {
    const q = db.one("SELECT * FROM quotation WHERE id = ?", [target.id]);
    changes = [{ field: "status", label: "状态", from: q.status, to: slots.to_status }];
    impact = "该报价单将退出「进行中」统计；若推进为「已转合同」，请改用「报价转合同」。";
  } else if (at.startsWith("UPDATE_")) {
    const table = ({ UPDATE_CONTRACT: "contract", UPDATE_CUSTOMER: "customer", UPDATE_QUOTATION: "quotation", UPDATE_DELIVERY: "delivery", UPDATE_ACCEPTANCE: "acceptance", UPDATE_INVOICE: "invoice", UPDATE_PAYMENT: "payment" })[at];
    const row = target.id ? db.one(`SELECT * FROM ${table} WHERE id = ?`, [target.id]) : null;
    const fields = slots.fields || {};
    if (fields && typeof fields === "object") {
      for (const [k, v] of Object.entries(fields)) {
        if (!UPDATABLE[table].includes(k)) continue;
        const nv = k === "amount" ? _norm_amount(v) : (k.endsWith("_date") ? _norm_date(v) : v);
        if (nv == null) continue;
        changes.push({ field: k, label: FIELD_LABELS[k] || k, from: row ? row[k] : null, to: nv });
      }
    }
  } else if (at === "CONVERT_QUOTATION_TO_CONTRACT") {
    const q = db.one("SELECT * FROM quotation WHERE id = ?", [refs.quotation_ref.id]);
    const n = db.scalar("SELECT COUNT(*) FROM quotation_item WHERE quotation_id=? AND is_deleted=0", [q.id]);
    changes = [{ field: "来源报价单", label: "来源报价单", from: "—", to: q.quotation_no },
      { field: "合同金额", label: "合同金额", from: "—", to: q.amount },
      { field: "明细条数", label: "明细条数", from: "—", to: `${n} 条` }];
    impact = "报价单状态将推进为「已转合同」，退出「报价中」统计。";
  } else if (at === "ARCHIVE_CONTRACT") {
    changes = [{ field: "is_archived", label: "归档", from: "否", to: "是" }];
    impact = "该合同将从台账默认视图中隐藏（数据保留）。";
  } else if (at === "UNARCHIVE_CONTRACT") {
    changes = [{ field: "is_archived", label: "归档", from: "是", to: "否" }];
  } else if (at === "CREATE_PAYMENT_PLAN") {
    changes = [{ field: "seq_no", label: "期次", from: "—", to: `第 ${slots.seq_no} 期` },
      { field: "plan_amount", label: "约定金额", from: "—", to: slots.plan_amount },
      { field: "due_date", label: "约定回款日期", from: "—", to: slots.due_date }];
  } else if (at === "CREATE_CONTRACT" || at === "CREATE_CONTRACT_FROM_TEMPLATE") {
    changes = [{ field: "客户", label: "客户", from: "—", to: target.label },
      { field: "服务期", label: "服务期", from: "—", to: `${slots.service_start_date} ~ ${slots.service_end_date}` }];
    if (slots.amount) changes.push({ field: "amount", label: "金额", from: "—", to: `${slots.amount} 元（${slots.amount_type || "合同总额"}）` });
  } else if (at === "CREATE_CONTRACT_VERSION") {
    changes = [{ field: "content", label: "新增正文", from: "—", to: `${String(slots.content || "").length} 字` }];
  }

  return { action_type: at, level: plan.level, target: { type: target.type, id: target.id, label: target.label || "（新建）" }, changes, impact };
}

function _predict_stage_text(contract_id, new_status) {
  const f = db.one(`SELECT * FROM (${proc._CONTRACT_FACT}) t WHERE t.contract_id = ?`, [contract_id]);
  if (!f) return "";
  f.contract_status = new_status;
  const st = proc._stages(f);
  const cur = proc._current_stage(f, st);
  if (cur === "已完结") return "该合同将进入「已完结」，退出在办统计。";
  return `该合同的进程阶段将推进到「${cur}」，建议动作：${proc.NEXT_ACTION[cur] || "—"}。`;
}

// ---------------- 执行 ----------------
function executePlan(plan, op_id, source = "自然语言") {
  const { action_type: at, slots, refs } = plan;
  const target = plan.target;
  let created = null;
  let log_action = "CREATE";

  if (at === "CREATE_CUSTOMER") {
    const cid = db.new_id();
    db.run("INSERT INTO customer(id,name,contact_name,contact_phone,address,owner_id,remark,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [cid, slots.customer_name, slots.contact_name || null, slots.contact_phone || null, slots.address || null, op_id, slots.remark || null, db.now_iso(), op_id, db.now_iso(), op_id]);
    created = { type: "customer", id: cid, label: slots.customer_name };
  } else if (at === "CREATE_QUOTATION") {
    const qid = db.new_id();
    const no = db.next_no("BJ");
    const amount = slots.amount;
    const valid = slots.valid_until || db.days_ahead(14);
    db.run("INSERT INTO quotation(id,quotation_no,customer_id,amount,valid_until,payment_terms,status,owner_id,current_version_no,remark,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [qid, no, refs.customer_ref.id, amount, valid, slots.payment_terms || null, "草稿", op_id, "V1.0", null, db.now_iso(), op_id, db.now_iso(), op_id]);
    db.run("INSERT INTO quotation_version(id,quotation_id,version_no,amount,items_snapshot,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
      [db.new_id(), qid, "V1.0", amount, "[]", "初始版本", op_id, db.now_iso()]);
    created = { type: "quotation", id: qid, label: `${no} · ${amount} 元` };
  } else if (at === "CREATE_CONTRACT" || at === "CREATE_CONTRACT_FROM_TEMPLATE") {
    const cust_id = refs.customer_ref.id;
    const name = slots.name || `${refs.customer_ref.label} ${slots.contract_type || "服务合同"}`;
    let amount = slots.amount, amount_type = slots.amount_type || "合同总额";
    if (amount == null) { amount = null; amount_type = "不适用"; }
    const cid = db.new_id();
    const no = db.next_no("HT");
    const tmpl_id = at === "CREATE_CONTRACT_FROM_TEMPLATE" ? refs.template_ref.id : null;
    db.run("INSERT INTO contract(id,contract_no,name,contract_type,customer_id,amount,amount_type,currency,service_start_date,service_end_date,sign_date,planned_delivery_date,auto_renewal,source_quotation_id,template_id,payment_terms,status,owner_id,current_version_no,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [cid, no, name, slots.contract_type || "服务合同", cust_id, amount, amount_type, "CNY", slots.service_start_date, slots.service_end_date, slots.sign_date || null, slots.planned_delivery_date || null, slots.auto_renewal ? 1 : 0, null, tmpl_id, slots.payment_terms || null, "草稿", op_id, "V1.0", db.now_iso(), op_id, db.now_iso(), op_id]);
    db.run("INSERT INTO contract_item(id,contract_id,name,spec,quantity,unit_price,amount,sort_no) VALUES(?,?,?,?,?,?,?,?)",
      [db.new_id(), cid, "合同标的（待补充）", null, "1", amount || "0.00", amount || "0.00", 0]);
    let body;
    if (at === "CREATE_CONTRACT_FROM_TEMPLATE") {
      const tv = db.one("SELECT content FROM contract_template_version WHERE template_id=? ORDER BY created_at DESC LIMIT 1", [tmpl_id]);
      body = (tv && tv.content) ? tv.content : _genContractBody(name, refs.customer_ref.label, slots, no);
    } else {
      body = _genContractBody(name, refs.customer_ref.label, slots, no);
    }
    db.run("INSERT INTO contract_version(id,contract_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [db.new_id(), cid, "V1.0", body, "初始版本", op_id, db.now_iso()]);
    created = { type: "contract", id: cid, label: `${no} · ${name}` };
  } else if (at === "CONVERT_QUOTATION_TO_CONTRACT") {
    const q = db.one("SELECT * FROM quotation WHERE id = ?", [refs.quotation_ref.id]);
    const cust_id = q.customer_id, amount = q.amount, src_q = q.id;
    const name = slots.name || `${db.one("SELECT name FROM customer WHERE id=?", [cust_id]).name} ${q.quotation_no} 合同`;
    const cid = db.new_id();
    const no = db.next_no("HT");
    db.run("INSERT INTO contract(id,contract_no,name,contract_type,customer_id,amount,amount_type,currency,service_start_date,service_end_date,sign_date,planned_delivery_date,auto_renewal,source_quotation_id,payment_terms,status,owner_id,current_version_no,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [cid, no, name, slots.contract_type || "服务合同", cust_id, amount, "合同总额", "CNY", slots.service_start_date, slots.service_end_date, slots.sign_date || null, slots.planned_delivery_date || null, 1, src_q, slots.payment_terms || null, "草稿", op_id, "V1.0", db.now_iso(), op_id, db.now_iso(), op_id]);
    db.run("INSERT INTO contract_item(id,contract_id,name,spec,quantity,unit_price,amount,sort_no) VALUES(?,?,?,?,?,?,?,?)",
      [db.new_id(), cid, "合同标的（待补充）", null, "1", amount || "0.00", amount || "0.00", 0]);
    const items = db.rows("SELECT * FROM quotation_item WHERE quotation_id=? AND is_deleted=0 ORDER BY sort_no", [q.id]);
    for (const it of items) db.run("INSERT INTO contract_item(id,contract_id,name,spec,quantity,unit_price,amount,sort_no) VALUES(?,?,?,?,?,?,?,?)",
      [db.new_id(), cid, it.name, it.spec, it.quantity, it.unit_price, it.amount, it.sort_no]);
    const body = `【合同名称】${name}\n【客户】${db.one("SELECT name FROM customer WHERE id=?", [cust_id]).name}\n【服务期】${slots.service_start_date} 至 ${slots.service_end_date}\n【金额】${amount} 元\n【合同编号】${no}\n\n（本正文由系统依据合同要素生成，可编辑后创建新版本）`;
    db.run("INSERT INTO contract_version(id,contract_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [db.new_id(), cid, "V1.0", body, "初始版本", op_id, db.now_iso()]);
    _advance("QUOTATION", src_q, "已转合同", op_id, "报价转合同", source);
    created = { type: "contract", id: cid, label: `${no} · ${name}` };
  } else if (at === "CREATE_DELIVERY") {
    const rid = db.new_id();
    db.run("INSERT INTO delivery(id,contract_id,content,quantity,ship_date,logistics_no,receipt_status,receipt_date,remark,created_at,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      [rid, target.id, slots.content, slots.quantity || null, slots.ship_date, slots.logistics_no || null, slots.receipt_status || "待签收", slots.receipt_date || null, slots.remark || null, db.now_iso(), op_id, db.now_iso()]);
    created = { type: "delivery", id: rid, label: `${slots.ship_date} 交付 ${slots.content}` };
  } else if (at === "CREATE_ACCEPTANCE") {
    const rid = db.new_id();
    db.run("INSERT INTO acceptance(id,contract_id,accept_date,result,remark,created_at,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      [rid, target.id, slots.accept_date, slots.accept_result, slots.remark || null, db.now_iso(), op_id, db.now_iso()]);
    created = { type: "acceptance", id: rid, label: `${slots.accept_date} 验收${slots.accept_result}` };
  } else if (at === "CREATE_INVOICE") {
    const rid = db.new_id();
    db.run("INSERT INTO invoice(id,contract_id,invoice_no,invoice_date,amount,receipt_status,remark,created_at,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [rid, target.id, slots.invoice_no, slots.invoice_date, slots.amount, slots.receipt_status || "待签收", slots.remark || null, db.now_iso(), op_id, db.now_iso()]);
    created = { type: "invoice", id: rid, label: `发票 ${slots.invoice_no} · ${slots.amount} 元` };
  } else if (at === "CREATE_PAYMENT") {
    const rid = db.new_id();
    db.run("INSERT INTO payment(id,contract_id,received_date,amount,serial_no,remark,created_at,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [rid, target.id, slots.received_date, slots.amount, slots.serial_no || null, slots.remark || null, db.now_iso(), op_id, db.now_iso()]);
    const alloc = db.allocate_payments(target.id);
    created = { type: "payment", id: rid, label: `回款 ${slots.amount} 元（${slots.received_date}）` };
    plan._alloc = alloc;
  } else if (at === "CREATE_PAYMENT_PLAN") {
    db.run("INSERT INTO contract_payment_plan(id,contract_id,seq_no,plan_amount,due_date,remark,created_at) VALUES(?,?,?,?,?,?,?)",
      [db.new_id(), target.id, slots.seq_no, slots.plan_amount, slots.due_date, slots.remark || null, db.now_iso()]);
    created = { type: "payment_plan", id: null, label: `第 ${slots.seq_no} 期 ${slots.plan_amount} 元（${slots.due_date}）` };
  } else if (at === "ADVANCE_CONTRACT_STATUS") {
    _advance("CONTRACT", target.id, slots.to_status, op_id, slots.remark, source);
    log_action = "STATUS_CHANGE";
    created = { type: "contract", id: target.id, label: target.label };
  } else if (at === "ADVANCE_QUOTATION_STATUS") {
    _advance("QUOTATION", target.id, slots.to_status, op_id, slots.remark, source);
    log_action = "STATUS_CHANGE";
    created = { type: "quotation", id: target.id, label: target.label };
  } else if (at === "ARCHIVE_CONTRACT") {
    db.run("UPDATE contract SET is_archived = 1, updated_at=? WHERE id=?", [db.now_iso(), target.id]);
    created = { type: "contract", id: target.id, label: target.label };
  } else if (at === "UNARCHIVE_CONTRACT") {
    db.run("UPDATE contract SET is_archived = 0, updated_at=? WHERE id=?", [db.now_iso(), target.id]);
    created = { type: "contract", id: target.id, label: target.label };
  } else if (at === "CREATE_CONTRACT_VERSION") {
    const c = db.one("SELECT current_version_no FROM contract WHERE id=?", [target.id]);
    const nxt = _bump(c.current_version_no);
    db.run("INSERT INTO contract_version(id,contract_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [db.new_id(), target.id, nxt, slots.content, slots.change_summary || null, op_id, db.now_iso()]);
    db.run("UPDATE contract SET current_version_no=?, updated_at=? WHERE id=?", [nxt, db.now_iso(), target.id]);
    created = { type: "contract_version", id: target.id, label: `${target.label} → ${nxt}` };
  } else if (at.startsWith("UPDATE_")) {
    const table = ({ UPDATE_CONTRACT: "contract", UPDATE_CUSTOMER: "customer", UPDATE_QUOTATION: "quotation", UPDATE_DELIVERY: "delivery", UPDATE_ACCEPTANCE: "acceptance", UPDATE_INVOICE: "invoice", UPDATE_PAYMENT: "payment" })[at];
    const fields = slots.fields || {};
    const sets = [], vals = [], before = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!UPDATABLE[table].includes(k)) continue;
      const nv = k === "amount" ? _norm_amount(v) : (k.endsWith("_date") ? _norm_date(v) : v);
      if (nv == null) continue;
      before[k] = target.id ? (db.one(`SELECT ${k} AS v FROM ${table} WHERE id=?`, [target.id]) || {}).v : null;
      sets.push(`${k}=?`); vals.push(nv);
    }
    if (sets.length) {
      sets.push("updated_at=?"); vals.push(db.now_iso()); vals.push(target.id);
      db.run(`UPDATE ${table} SET ${sets.join(", ")} WHERE id=?`, vals);
    }
    plan._before = before;
    log_action = "UPDATE";
    created = { type: table, id: target.id, label: target.label };
  } else {
    throw new Error(`未实现的动作：${at}`);
  }

  const reversible = (plan.level === 1 && log_action === "CREATE") ? 1 : 0;
  const log_id = db.new_id();
  db.run("INSERT INTO operation_log(id,operator_id,source,action,object_type,object_id,object_label,before_value,after_value,reversible,reverted,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    [log_id, op_id, source, log_action, created.type, created.id, created.label,
      JSON.stringify(plan._before || {}), JSON.stringify({ slots: Object.fromEntries(Object.entries(plan.slots || {})) }), reversible, 0, db.now_iso()]);
  return { created, undoable: !!reversible, log_id, allocation: plan._alloc };
}

function _genContractBody(name, custName, slots, no) {
  return `【合同名称】${name}\n【客户】${custName}\n【服务期】${slots.service_start_date} 至 ${slots.service_end_date}\n【金额】${slots.amount || "不适用"} 元\n【合同编号】${no}\n\n（本正文由系统依据合同要素生成，可编辑后创建新版本）`;
}

export function _advance(obj, oid, to, op_id, remark, source) {
  const table = obj === "CONTRACT" ? "contract" : "quotation";
  const cur = (db.one(`SELECT status FROM ${table} WHERE id=?`, [oid]) || {}).status;
  if (!TRANSITIONS[obj][cur] || !TRANSITIONS[obj][cur].includes(to)) throw new Error(`不允许从「${cur}」推进到「${to}」`);
  db.run(`UPDATE ${table} SET status=?, updated_at=?, updated_by=? WHERE id=?`, [to, db.now_iso(), op_id, oid]);
  db.run("INSERT INTO status_log(id,object_type,object_id,from_status,to_status,changed_by,changed_at,source,remark) VALUES(?,?,?,?,?,?,?,?,?)",
    [db.new_id(), obj, oid, cur, to, op_id, db.now_iso(), source, remark || null]);
  if (obj === "CONTRACT" && (to === "已到期" || to === "已终止")) db.run("UPDATE contract SET is_archived=1 WHERE id=?", [oid]);
}

export function _bump(v) {
  const m = String(v || "V1.0").match(/V(\d+)\.(\d+)/);
  if (!m) return "V1.1";
  return `V${m[1]}.${parseInt(m[2], 10) + 1}`;
}

// ---------------- 查询 ----------------
function _customer_facts(text) {
  const cu = res.resolve_customer(text);
  if (cu.status !== "unique") return null;
  const cid = cu.id;
  const cust = db.one("SELECT name FROM customer WHERE id = ?", [cid]) || {};
  const cs = db.rows("SELECT id, amount, amount_type FROM contract WHERE customer_id=? AND is_deleted=0", [cid]);
  const total = cs.reduce((s, c) => s + (c.amount_type === "不适用" ? 0 : db.to_cents(c.amount)), 0);
  const paid = cs.reduce((s, c) => s + parseInt(db.scalar("SELECT COALESCE(SUM(CAST(ROUND(amount*100) AS INTEGER)),0) FROM payment WHERE contract_id=? AND is_deleted=0", [c.id]) || 0, 10), 0);
  const qn = db.scalar("SELECT COUNT(*) FROM quotation WHERE customer_id=? AND is_deleted=0", [cid]);
  const parts = [`合同 ${cs.length} 份 · 合同总额 ¥${db.display_money(total)} · 已回款 ¥${db.display_money(paid)} · 未回款 ¥${db.display_money(total - paid)} · 报价单 ${qn} 份`];
  const procs = proc.list_processes({ customer_id: cid, include_closed: false });
  if (procs.length) {
    const p = procs[0];
    parts.push(`在办 ${procs.length} 单，当前卡在「${p.current_stage}」已 ${p.stage_days} 天` + (p.is_stagnant ? "（已停滞）" : ""));
  }
  return { reply: (cust.name || "") + "\n" + parts.join(" · "),
    events: [ev("sources", { kind: "record", label: "客户档案、合同台账、回款记录", definition: "按客户汇总，直接读台账，不经过模型", rowcount: cs.length })],
    entities: [{ type: "customer", id: cid, label: cust.name || "" }] };
}

function _days_to(dateStr) {
  if (!dateStr) return null;
  try {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const d = new Date(dateStr + "T00:00:00");
    return Math.round((t - d) / 86400000);
  } catch { return null; }
}

function _contract_facts(text, context, stack) {
  let rc = res.resolve_contract(text, context, stack);
  if (rc.status !== "unique" && context.contract_id) rc = { status: "unique", id: context.contract_id, label: "" };
  if (rc.status !== "unique") return null;
  const c = db.one("SELECT c.*, u.name AS customer_name FROM contract c JOIN customer u ON u.id = c.customer_id WHERE c.id = ?", [rc.id]);
  if (!c) return null;
  const amt = db.amount_summary(c.id);
  const days = _days_to(c.service_end_date);

  const parts = [];
  if (/到期|服务期|什么时候|截止|多久/.test(text)) {
    parts.push(`服务期 ${c.service_start_date} 至 ${c.service_end_date}`);
    if (days != null) parts.push(days >= 0 ? `还有 ${days} 天到期` : `已过期 ${-days} 天`);
  }
  if (/签署|签的/.test(text) && c.sign_date) parts.push(`签署日期 ${c.sign_date}`);
  if (/金额|多少钱/.test(text)) {
    parts.push(amt.contract_amount == null ? "合同金额 不适用" : `合同金额 ¥${amt.contract_amount}（${c.amount_type}）`);
    if (amt.unpaid_amount != null) parts.push(`未回款 ¥${amt.unpaid_amount}`);
  }
  if (/状态|进度/.test(text)) parts.push(`状态 ${c.status}`);
  if (!parts.length) parts.push(`状态 ${c.status}`, `服务期 ${c.service_start_date} 至 ${c.service_end_date}`, amt.contract_amount ? `金额 ¥${amt.contract_amount}` : "金额 不适用");

  const head = `${c.customer_name} · ${c.name}（${c.contract_no}）`;
  return { reply: head + "\n" + parts.join(" · "),
    events: [ev("sources", { kind: "record", label: "合同台账", definition: "直接读取合同台账，不经过模型", rowcount: 1 })],
    entities: [{ type: "contract", id: c.id, label: `${c.contract_no} ${c.name}` }] };
}

async function run_query(text, parsed, context, stack, history) {
  const kind = String(parsed.query_kind || "").toUpperCase();

  if (ai.is_legal_question(text) && kind === "CONTRACT_QA") {
    return { reply: "我不对条款的法律含义、合法性或风险作判断——这超出我的能力范围，建议咨询法务。但如果你想知道合同里**写了什么**，我可以照原文回答。", events: [ev("refused", { reason: "legal_judgement" })] };
  }

  const m = metrics.compute(text);
  if (m) {
    return { reply: answer.metric_reply(m), entities: m.items || [], events: [ev("sources", { kind: "metric", label: "服务端口径计算", metric: m.metric, definition: m.definition, detail: m.detail, rowcount: (m.items || []).length || 1 })] };
  }

  let has_contract = !!(context.contract_id) || !!_slot(parsed, "contract_ref");

  if (/这些|所有|全部|各个|每份|分别|多家|各家/.test(text)) {
    const field = Object.keys(NON_QUERYABLE).find((k) => text.includes(k));
    if (field) return { reply: NON_QUERYABLE[field], events: [ev("non_queryable", { field })] };
  }

  if (!has_contract) {
    const guess = res.resolve_contract(text, context, stack);
    if (guess.status === "unique") { has_contract = true; if (!parsed.slots) parsed.slots = {}; parsed.slots.contract_ref = { raw: text, normalized: guess.label || "" }; }
  }

  if (!has_contract) {
    if (/这份|该合同|此合同|这个合同|那份|该份/.test(text)) return { reply: "要问哪一份合同的条款？你可以在合同详情页点「问条款」把上下文带进来，或者直接说合同编号。", events: [ev("clarify", { message: "请先指定合同", candidates: [], slot: "contract_ref" })] };
    const field = Object.keys(NON_QUERYABLE).find((k) => text.includes(k));
    if (field) return { reply: NON_QUERYABLE[field], events: [ev("non_queryable", { field })] };
  }

  const is_clause = /付款|违约|条款|保密|知识产权|争议|赔偿|验收标准|约定/.test(text);
  if (!is_clause) {
    if (!/合同|那单|这单|编号/.test(text)) { const cf = _customer_facts(text); if (cf) return cf; }
    if (has_contract) { const cf = _contract_facts(text, context, stack); if (cf) return cf; }
  }

  const want_qa = has_contract && (kind === "CONTRACT_QA" || kind === "" || kind === "CONTRACT_QA");
  if (want_qa) {
    if (!db.get_setting("ai_contract_qa_enabled", true)) return { reply: "条款问答已在设置中关闭。", events: [ev("degraded")] };
    const rc = res.resolve_contract(String(_slot(parsed, "contract_ref") || ""), context, stack);
    if (rc.status !== "unique") {
      if (rc.status === "multi") return { reply: "先确认是哪份合同：", events: [ev("clarify", { message: "请先选定合同", candidates: rc.candidates, slot: "contract_ref", allow_create: false })] };
      return { reply: "条款问答需要先指定一份合同。你可以在合同详情页点「问条款」，或直接说合同编号。", events: [ev("clarify", { message: "请先指定合同", candidates: [], slot: "contract_ref" })] };
    }
    const c = db.one("SELECT * FROM contract WHERE id=?", [rc.id]);
    const ver = db.one("SELECT * FROM contract_version WHERE contract_id=? ORDER BY created_at DESC LIMIT 1", [c.id]);
    const out = await ai.contract_qa(text, `${c.contract_no} ${c.name}`, ver ? ver.content : "");
    const events = [ev("citation", { version_no: ver ? ver.version_no : null, excerpt: out.excerpt }), ev("disclaimer", { text: "AI 回答仅供参考，请以合同原文为准。" })];
    return { reply: out.answer, events, entities: [{ type: "contract", id: c.id, label: `${c.contract_no} ${c.name}` }] };
  }

  let sqlInfo;
  try {
    proc.refresh_snapshot();
    sqlInfo = await ai.nl2sql(text, history);
  } catch (e) {
    return { reply: aiFailureReply(e), events: [ev("degraded", { message: "模型服务不可用，已降级为纯台账模式", detail: String(e).slice(0, 200) })] };
  }

  const { sql, hint, definition } = sqlInfo;
  if (hint === "NOT_QUERYABLE" || sql == null) {
    const field = Object.keys(NON_QUERYABLE).find((k) => text.includes(k));
    if (field) return { reply: NON_QUERYABLE[field], events: [ev("non_queryable", { field })] };
    return { reply: "这个问题涉及的字段没有结构化存储，我无法统计。可以换个口径问我，或者我列出相关台账供你自己看。", events: [ev("non_queryable")] };
  }

  const [ok, s] = ai.sql_safe(sql);
  if (!ok) return { reply: CANNOT_ANSWER_TIP, events: [ev("blocked", { reason: s })] };

  let data;
  try { data = db.rows(s); }
  catch (e) { return { reply: CANNOT_ANSWER_TIP, events: [ev("error", { detail: e.message || String(e) })] }; }

  if (!data.length) return { reply: "没有查到符合条件的数据。可以换个说法，或者直接告诉我你要统计的口径，我来确认。", events: [ev("sources", { sql: s, sources: [], rowcount: 0 })] };

  const cols = Object.keys(data[0]);
  const tables = [...new Set((s.match(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi) || []).map((t) => t.replace(/^\s*(?:from|join)\s+/i, "")))];
  let reply = answer.compose(cols, data, text);
  if (definition) reply += "\n口径：" + definition;
  return { reply, entities: _entities_from_rows(data, tables),
    events: [ev("sources", { kind: "query", label: "临时查询（" + (answer.table_labels(tables).join("、") || "台账") + "）", definition: definition || "本次查询由模型临时生成，它未说明口径", tables, rowcount: data.length, sql: s }),
      ev("disclaimer", { text: "以上为临时查询结果，没有预置统计口径，建议核对后再使用。如果你需要一个固定口径的统计，告诉我，我可以把它固化下来。" })] };
}

function _entities_from_rows(data, tables) {
  if (!data.length) return [];
  const tset = new Set(tables);
  const mains = ["contract", "quotation", "customer"].filter((t) => tset.has(t));
  const out = [];
  const seen = new Set();
  for (const r of data.slice(0, answer.MAX_ROWS)) {
    const keys = Object.keys(r);
    let etype = null, eid = null, label = "";
    if (keys.includes("contract_no") && r.contract_no) { etype = "contract"; eid = r.contract_id || r.id; label = `${r.contract_no} ${r.contract_name || r.name || ""}`.trim(); }
    else if (keys.includes("quotation_no") && r.quotation_no) { etype = "quotation"; eid = r.quotation_id || r.id; label = `${r.quotation_no}（${r.customer_name || ""}）`.trim(); }
    else if (r.customer_id && r.customer_name) { etype = "customer"; eid = r.customer_id; label = String(r.customer_name); }
    if (!eid && keys.includes("id") && mains.length === 1 && ["contract", "quotation"].includes(mains[0])) {
      if (r.name || r.contract_no || r.quotation_no) { etype = mains[0]; eid = r.id; label = String(r.name || r.contract_no || r.quotation_no); }
    }
    if (eid && etype && !seen.has(etype + ":" + eid)) { seen.add(etype + ":" + eid); out.push({ type: etype, id: String(eid), label }); }
  }
  return out.slice(0, answer.MAX_ROWS);
}

// ---------------- 口径追问 ----------------
const _ASK_DEFINITION_RE = /怎么(定义|算|得出|来的|计算|理解|统计)|口径是什么|口径|什么(意思|含义)|依据是什么|为什么(是)?这个|这(个)?(数字|数)|凭什么/;

function explain_last_answer(history) {
  for (const m of [...history].reverse()) {
    if (m.role !== "assistant" || !m.payload) continue;
    let p; try { p = JSON.parse(m.payload); } catch { continue; }
    const events = p.events;
    if (!events) continue;
    const src = events.find((e) => e.event === "sources");
    if (!src) continue;
    const kind = src.kind;
    const definition = (src.definition || "").trim();
    const detail = (src.detail || "").trim();
    let head;
    if (kind === "metric") head = "上一句是**固定口径统计**，算法是：";
    else if (kind === "query") head = "上一句是**临时查询**，模型当时自己选了下面的算法（不是系统预置的口径）：";
    else if (kind === "record") head = "上一句是**直接从台账读的字段**，没有经过任何计算：";
    else head = "上一句的依据是：";
    const lines = [head];
    if (definition) lines.push(definition);
    if (detail && detail !== definition) lines.push("依据：" + detail);
    if (kind === "query") {
      if (src.sql) lines.push("原始查询附在下方，可展开核对。");
      if (!definition) lines.push("它当时没有交代口径 —— 这正是你觉得说不清的原因。建议改用有固定口径的问法。");
    }
    return { reply: lines.join("\n"), events: [ev("sources", { kind, label: src.label, definition, detail, sql: src.sql, rowcount: src.rowcount })], reply_only: true };
  }
  return null;
}

// ---------------- 主入口 ----------------
export async function handle(text, context = {}) {
  _pushHistory({ role: "user", content: text, payload: null });
  const op_id = db.current_operator_id();

  if (!db.get_setting("ai_enabled", true)) {
    const r = { reply: "AI 能力已在设置中关闭。台账、录入、提醒等功能不受影响。", events: [ev("degraded", { message: "AI 已关闭" })], reply_only: true };
    _recordAssistant(r); return r;
  }

  if (_ASK_DEFINITION_RE.test(text)) {
    const ex = explain_last_answer(_history);
    if (ex) { _recordAssistant(ex); return ex; }
    const r = { reply: "你指的是哪个数字？这轮对话里我还没有给出过统计结果，先问我一个具体的指标，之后你就可以随时追问它的口径。", events: [ev("clarify", { message: "暂无可解释的统计结果" })], reply_only: true };
    _recordAssistant(r); return r;
  }

  const mq = metrics.compute(text);
  if (mq) {
    const r = { reply: answer.metric_reply(mq), entities: mq.items || [], events: [ev("sources", { kind: "metric", label: "服务端口径计算", metric: mq.metric, definition: mq.definition, detail: mq.detail, rowcount: (mq.items || []).length || 1 })], reply_only: true };
    _recordAssistant(r); return r;
  }

  let parsed;
  try { parsed = await ai.extract_intent(text, { context, history: _history }); }
  catch (e) { const r = { reply: aiFailureReply(e), events: [ev("degraded", { message: "模型服务不可用", detail: String(e).slice(0, 200) })], reply_only: true }; _recordAssistant(r); return r; }

  if (!parsed || !Object.keys(parsed).length) {
    const hit = _loose_customer(text);
    if (hit) {
      const r = { reply: `你提到的是「${hit.name}」这个客户吗？想查它的数据、录记录，还是推进某个合同的状态？`,
        events: [ev("clarify", { message: "已定位到客户，需要明确要做什么", parsed_so_far: { "客户": hit.name }, candidates: [{ id: hit.id, label: `查看 ${hit.name} 的详情`, hint: "" }], slot: "intent", allow_create: false })],
        entities: [{ type: "customer", id: hit.id, label: hit.name }], reply_only: true };
      _recordAssistant(r); return r;
    }
    const r = { reply: "没太理解这句话。" + CANNOT_ANSWER_TIP, events: [ev("unknown")], reply_only: true };
    _recordAssistant(r); return r;
  }

  const intent = String(parsed.intent || "UNKNOWN").toUpperCase();

  if (intent === "QUERY") {
    const out = await run_query(text, parsed, context, _stack, _history);
    out.reply_only = true; _recordAssistant(out); return out;
  }

  if (intent !== "OPERATE") {
    const hit = _loose_customer(text);
    if (hit) {
      const r = { reply: `你提到的是「${hit.name}」这个客户吗？想办理什么——查它的数据、录记录、还是推进某个合同的状态？`,
        events: [ev("clarify", { message: "已定位到客户，需要明确要做什么", parsed_so_far: { "客户": hit.name }, candidates: [{ id: hit.id, label: `查看 ${hit.name} 的详情`, hint: "" }], slot: "intent", allow_create: false })],
        entities: [{ type: "customer", id: hit.id, label: hit.name }], reply_only: true };
      _recordAssistant(r); return r;
    }
    const fallback = "我暂时没理解。我可以帮你：查数据（「本月签了几份合同」）、录记录（「A 公司今天回款 20 万」）、推进度（「A 公司那个合同签了」）、问条款（「付款条件是什么」）。";
    const r = { reply: parsed.assistant_text || fallback, events: [ev("unknown", { text })], reply_only: true };
    _recordAssistant(r); return r;
  }

  const at = normalize_action(parsed.action_type);
  if (!at) {
    const r = { reply: `我识别到这是一个操作，但动作不在支持清单内（识别为：${parsed.action_type}）。请到对应页面的表单里完成，或换个说法。`, events: [ev("unknown", { action: parsed.action_type })], reply_only: true };
    _recordAssistant(r); return r;
  }

  const level = ACTIONS[at].level;

  if (level === 3) {
    // 条件型三级：改「已生效合同金额」只在合同确实处于履行中/已到期时才拒绝；
    // 还在草稿阶段、或压根没指明是哪份合同，降级为普通二级修改，让后续流程去问。
    if (at === "UPDATE_CONTRACT_AMOUNT_EFFECTIVE") {
      const rc = res.resolve_contract(String(_slot(parsed, "contract_ref") || ""), context, _stack);
      if (rc.status === "unique") {
        const st = (db.one("SELECT status FROM contract WHERE id = ?", [rc.id]) || {}).status;
        if (st !== "履行中" && st !== "已到期") {
          parsed.action_type = "UPDATE_CONTRACT";
          parsed.slots = parsed.slots || {};
          parsed.slots.contract_ref = { raw: String(_slot(parsed, "contract_ref") || ""), normalized: rc.label };
          parsed.slots.fields = { raw: "", normalized: { amount: _slot(parsed, "amount") } };
        }
        // 合同确实处于履行中/已到期 → 保持三级拒绝（落到下面的 _reject）
      } else if (!/履行中|已生效|生效中|生效的/.test(text)) {
        parsed.action_type = "UPDATE_CONTRACT";
        parsed.slots = parsed.slots || {};
        parsed.slots.fields = { raw: "", normalized: { amount: _slot(parsed, "amount") } };
      }
      // 若改动后仍是三级动作，才拒绝；否则放行到下方 _route2 走正常二级流程
      const nt = normalize_action(parsed.action_type);
      if (nt && ACTIONS[nt].level === 3) { const r = _reject(parsed.action_type, parsed, context); _recordAssistant(r); return r; }
    } else {
      const r = _reject(at, parsed, context);
      _recordAssistant(r); return r;
    }
  }

  return _route2(parsed, context, op_id);
}

// 统一执行路由（二级/条件降级后的二级）
function _route2(parsed, context, op_id) {
  const at = normalize_action(parsed.action_type);
  const built = build_plan(at, parsed, context, _stack, op_id);
  if (!built.ok) {
    if (built.reject) { const r = { reply: built.reject.message, events: [ev("rejected", built.reject)], reply_only: true }; _recordAssistant(r); return r; }
    const r = { reply: built.clarify.message, events: [ev("clarify", built.clarify)], reply_only: true }; _recordAssistant(r); return r;
  }
  const plan = built.plan;
  const target = plan.target;

  if (plan.level === 1) {
    try {
      db.run("BEGIN");
      const result = executePlan(plan, op_id, "自然语言");
      db.run("COMMIT");
      const r = _result_reply(plan, result, 1);
      _recordAssistant(r); return r;
    } catch (e) {
      try { db.run("ROLLBACK"); } catch {}
      const r = { reply: `执行失败：${e.message || e}`, events: [ev("error", { detail: e.message || String(e) })], reply_only: true };
      _recordAssistant(r); return r;
    }
  }

  const card = make_card(plan);
  const aid = db.new_id();
  const exp = new Date(Date.now() + 10 * 60000).toISOString().slice(0, 19);
  card.action_id = aid; card.expires_at = exp;
  _pending.set(aid, { plan, op_id, createdAt: db.now_iso() });
  const r = { reply: `好的，我来${ACTIONS[at].label}。请确认以下内容：`, events: [ev("confirm_card", card)], pending: card, reply_only: false };
  _recordAssistant(r); return r;
}

function _result_reply(plan, result, level) {
  const created = result.created;
  const at = plan.action_type;
  const verb = at.startsWith("ADVANCE") ? "已推进" : at.startsWith("UPDATE") ? "已更新" : "已录入";
  const reply = `${verb}：${ACTIONS[at].label} · ${created.label}`;
  const events = [ev("result", { message: reply, created, undoable: result.undoable, log_id: result.log_id, allocation: result.allocation })];
  const ent = [{ type: created.type, id: created.id, label: created.label }];
  if (plan.target.id && created.type !== plan.target.type) ent.push({ type: plan.target.type, id: plan.target.id, label: plan.target.label });
  return { reply, events, result, entities: ent, reply_only: false };
}

function _loose_customer(text) {
  const hits = {};
  for (const c of db.rows("SELECT id, name FROM customer WHERE is_deleted = 0")) {
    for (const n of [3, 2]) if (c.name.length >= n && c.name.slice(0, n).includes(text)) { hits[c.id] = c; break; }
  }
  return Object.keys(hits).length === 1 ? hits[Object.keys(hits)[0]] : null;
}

function _reject(at, parsed, context) {
  const messages = {
    DELETE_ANY: "删除属于不可通过对话执行的操作——一旦删错，关联的履约记录与台账会一并受影响。请到对应详情页手动删除。",
    TERMINATE_CONTRACT: "合同终止会改变履约与回款的统计口径，不支持对话执行。请到合同详情页操作。",
    VOID_CONTRACT: "合同作废不支持对话执行，请到合同详情页操作。",
    VOID_QUOTATION: "报价单作废不支持对话执行，请到报价单详情页操作。",
    UPDATE_CONTRACT_AMOUNT_EFFECTIVE: "已生效合同的金额变更需要记录变更原因并留痕，不支持对话执行。请到合同详情页操作。",
    BATCH_OPERATION: "批量操作不支持对话执行。请逐个处理，或在对话中分别说明。",
    UPLOAD_ATTACHMENT: "附件需要通过文件上传完成，无法用一句话做到。请到合同详情页的附件区上传。",
  };
  let link = "";
  const rc = res.resolve_contract(String(_slot(parsed, "contract_ref") || _slot(parsed, "quotation_ref") || ""), context, _stack);
  if (rc.status === "unique") link = ` → ${rc.label}`;
  return { reply: (messages[at] || "该操作不支持通过对话执行。") + link, events: [ev("rejected", { code: 42203, action_type: at, message: messages[at] || "", guide: { text: "请到详情页手动操作", target: rc.label } })], reply_only: true };
}

// ---------------- 确认 / 取消 / 撤销 ----------------
export async function confirmAction(aid) {
  const pa = _pending.get(aid);
  if (!pa) return { ok: false, reply: "找不到这张确认卡。" };
  if (pa.expires_at < db.now_iso()) { _pending.delete(aid); return { ok: false, reply: "确认卡已过期（有效期 10 分钟），请重新发起。" }; }
  const plan = pa.plan;
  let result;
  try {
    db.run("BEGIN");
    result = executePlan(plan, pa.op_id, "自然语言");
    db.run("COMMIT");
  } catch (e) { try { db.run("ROLLBACK"); } catch {} return { ok: false, reply: `执行失败：${e.message || e}` }; }
  _pending.delete(aid);
  const out = _result_reply(plan, result, 2);
  out.ok = true;
  _recordAssistant(out);
  return out;
}

export function cancelAction(aid) {
  if (_pending.has(aid)) { _pending.delete(aid); return { ok: true, reply: "已取消，数据没有发生任何变化。" }; }
  return { ok: false, reply: "这张确认卡已经不存在了。" };
}

export function undo(log_id) {
  const lg = db.one("SELECT * FROM operation_log WHERE id = ?", [log_id]);
  if (!lg) return { ok: false, reply: "找不到这条操作记录。" };
  if (!lg.reversible || lg.reverted) return { ok: false, reply: "这条操作不可撤销（只有一级的新增记录支持撤销）。" };
  const table = ({ customer: "customer", quotation: "quotation", contract: "contract", delivery: "delivery", acceptance: "acceptance", invoice: "invoice", payment: "payment" })[lg.object_type];
  if (!table || !lg.object_id) return { ok: false, reply: "该类型不支持撤销。" };
  db.run("BEGIN");
  db.run(`UPDATE ${table} SET is_deleted = 1 WHERE id = ?`, [lg.object_id]);
  db.run("UPDATE operation_log SET reverted = 1 WHERE id = ?", [log_id]);
  db.run("INSERT INTO operation_log(id,operator_id,source,action,object_type,object_id,object_label,reversible,reverted,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [db.new_id(), db.current_operator_id(), "自然语言", "UNDO", lg.object_type, lg.object_id, lg.object_label, 0, 0, db.now_iso()]);
  db.run("COMMIT");
  const r = { ok: true, reply: `已撤销：${lg.object_label}（数据保留在回收状态，未物理删除）`, events: [ev("result", { message: `已撤销：${lg.object_label}`, created: { type: lg.object_type, id: lg.object_id, label: lg.object_label } })] };
  return r;
}
