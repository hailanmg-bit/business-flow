// api.js — 浏览器端本地 API 层。
//
// 作用：把后端 server.py 的 59 个 /api/v1 路由，在浏览器里用 sql.js 直接实现，
// 让本地那套前端（app/web/app.js）可以原样运行 —— 前端只把 fetch 换成这里的 apiLocal。
//
// 约定（与 FastAPI 版逐字段一致）：
//   · 成功返回 data 本体；前端 api() 会包一层 {code:0,message:'ok',data}
//   · 失败抛 Error，e.code / e.field 与后端 fail() 一致
//   · 删除类接口返回 null（对应 HTTP 204）
//
// 浏览器差异：
//   · 附件原本落磁盘，这里改存 IndexedDB（独立库 bizflow_files），file_path 存键
//   · 文档导出（docx/print）与 CSV/JSON 导出走浏览器下载，见文件末尾的 export* 函数
import * as db from "./db.js";
import * as proc from "./process.js";
import * as engine from "./engine.js";
import * as catalog from "./catalog.js";
import * as ai from "./ai.js";
import * as tasks from "./tasks.js";
import * as docs from "./docs.js";

const { ACTIONS, TRANSITIONS, METRICS, FIELD_LABELS } = catalog;

function fail(code, message, field) {
  const e = new Error(message || "请求失败");
  e.code = code;
  if (field) e.field = field;
  throw e;
}

function op_name(oid) {
  if (!oid) return null;
  const r = db.one("SELECT name FROM operator WHERE id=?", [oid]);
  return r ? r.name : null;
}

function page_of(items, page, size) {
  const start = (page - 1) * size;
  return { list: items.slice(start, start + size), total: items.length, page, page_size: size };
}

const toBool = (v) => v === true || v === "true" || v === "1";

// ---------------- 路由表 ----------------
const ROUTES = [];
const route = (method, pattern, handler) => ROUTES.push({ method, segs: pattern.split("/").filter(Boolean), handler });
// 记录型接口（交付/验收/开票/回款）与后端 _RECORDS 一致
const RECORDS = {
  delivery: { plural: "deliveries", fields: ["content", "quantity", "ship_date", "logistics_no", "receipt_status", "receipt_date", "remark"], defaults: { receipt_status: "待签收" } },
  acceptance: { plural: "acceptances", fields: ["accept_date", "result", "remark"], defaults: { result: "待验收" } },
  invoice: { plural: "invoices", fields: ["invoice_no", "invoice_date", "amount", "receipt_status", "remark"], defaults: { receipt_status: "待签收" } },
  payment: { plural: "payments", fields: ["received_date", "amount", "serial_no", "payment_plan_id", "remark"], defaults: {} },
};
const DOC_KINDS = ["合同正本", "盖章扫描件", "报价单回签", "其他"];
const OBJ_TABLE = { CONTRACT: "contract", QUOTATION: "quotation" };

// ---------- 健康检查 / 设置 / 操作人 ----------
route("GET", "health", () => {
  const op = db.current_operator_id();
  return { status: "up", today: db.today_str(), operator: op_name(op), ai_enabled: db.get_setting("ai_enabled", true) };
});

route("GET", "settings", () => {
  const op = db.current_operator_id();
  return {
    current_operator_id: op,
    stagnation_threshold: db.get_setting("stagnation_threshold", {}),
    ai_enabled: db.get_setting("ai_enabled", true),
    ai_contract_qa_enabled: db.get_setting("ai_contract_qa_enabled", true),
    ai_notice_accepted_at: db.get_setting("ai_notice_accepted_at"),
    metrics: METRICS,
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, { level: v.level, label: v.label }])),
  };
});

route("PATCH", "settings", (p) => {
  for (const k of ["stagnation_threshold", "ai_enabled", "ai_contract_qa_enabled"]) {
    if (k in p.body) db.set_setting(k, p.body[k]);
  }
  return { updated: Object.keys(p.body) };
});

route("POST", "settings/current-operator", (p) => {
  db.set_setting("current_operator_id", p.body.operator_id ?? null);
  return { current_operator_id: p.body.operator_id ?? null };
});

route("POST", "settings/ai-notice-accepted", () => {
  db.set_setting("ai_notice_accepted_at", db.now_iso());
  return { accepted_at: db.now_iso() };
});

route("POST", "settings/ai/test", async () => {
  const model = ai.getModel();
  if (!ai.getApiKey()) {
    return { ok: false, stage: "配置", model, error: "没有配置 DeepSeek API Key",
      hint: "在「设置」页填入你的 Key（只保存在本浏览器 localStorage），或先用「跳过」浏览演示数据。" };
  }
  const t0 = Date.now();
  const r = await ai.testConnection();
  if (r.ok) return { ok: true, model, elapsed_ms: Date.now() - t0, reply: String(r.message || "").slice(0, 40) };
  return { ok: false, stage: "调用", model, error: String(r.message || "调用失败").slice(0, 300),
    hint: "检查 Key 是否有效、网络是否可达 api.deepseek.com。" };
});

route("GET", "operators", () => db.rows("SELECT id, name, is_active FROM operator WHERE is_deleted=0 ORDER BY created_at"));

route("POST", "operators", (p) => {
  const name = String(p.body.name || "").trim();
  if (!name) fail(40002, "缺少姓名", "name");
  if (db.one("SELECT id FROM operator WHERE lower(name)=lower(?) AND is_deleted=0", [name])) fail(40901, "该操作人已存在", "name");
  const oid = db.new_id();
  db.run("INSERT INTO operator(id,name,is_active,created_at,is_deleted) VALUES(?,?,1,?,0)", [oid, name, db.now_iso()]);
  return { id: oid, name };
});

route("DELETE", "operators/:oid", (p) => {
  const used = db.scalar("SELECT (SELECT COUNT(*) FROM operation_log WHERE operator_id=?) + (SELECT COUNT(*) FROM contract WHERE owner_id=?)", [p.params.oid, p.params.oid]);
  if (parseInt(used || 0, 10)) fail(40903, "该操作人已有历史记录，不能删除");
  db.run("UPDATE operator SET is_deleted=1 WHERE id=?", [p.params.oid]);
  return null;
});

// ---------- 客户 ----------
route("GET", "customers", (p) => {
  let sql = "SELECT c.*, o.name AS owner_name,"
    + " (SELECT COUNT(*) FROM contract x WHERE x.customer_id=c.id AND x.is_deleted=0) AS contract_count,"
    + " (SELECT COUNT(*) FROM quotation x WHERE x.customer_id=c.id AND x.is_deleted=0) AS quotation_count"
    + " FROM customer c LEFT JOIN operator o ON o.id=c.owner_id WHERE c.is_deleted=0";
  const ps = [];
  if (p.q.keyword) { sql += " AND (c.name LIKE ? OR c.contact_name LIKE ? OR c.contact_phone LIKE ?)"; ps.push(`%${p.q.keyword}%`, `%${p.q.keyword}%`, `%${p.q.keyword}%`); }
  if (p.q.owner_id) { sql += " AND c.owner_id=?"; ps.push(p.q.owner_id); }
  return page_of(db.rows(sql + " ORDER BY c.created_at DESC", ps), p.page, p.size);
});

route("POST", "customers", (p) => {
  const b = p.body;
  const name = String(b.name || "").trim();
  if (!name) fail(40002, "缺少客户名称", "name");
  if (db.one("SELECT id FROM customer WHERE lower(name)=lower(?) AND is_deleted=0", [name])) fail(40901, "客户名称已存在", "name");
  const op = db.current_operator_id();
  const cid = db.new_id();
  db.run("INSERT INTO customer(id,name,credit_code,contact_name,contact_phone,address,invoice_title,invoice_tax_no,invoice_bank,invoice_account,owner_id,remark,created_at,created_by,updated_at,updated_by) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [cid, name, b.credit_code ?? null, b.contact_name ?? null, b.contact_phone ?? null, b.address ?? null,
      b.invoice_title ?? null, b.invoice_tax_no ?? null, b.invoice_bank ?? null, b.invoice_account ?? null,
      b.owner_id || op, b.remark ?? null, db.now_iso(), op, db.now_iso(), op]);
  return { id: cid, name };
});

route("GET", "customers/:cid", (p) => {
  const cid = p.params.cid;
  const c = db.one("SELECT c.*, o.name AS owner_name FROM customer c LEFT JOIN operator o ON o.id=c.owner_id WHERE c.id=? AND c.is_deleted=0", [cid]);
  if (!c) fail(40101, "客户不存在");
  return {
    customer: c,
    contracts: db.rows("SELECT id, contract_no, name, amount, amount_type, status, service_start_date, service_end_date FROM contract WHERE customer_id=? AND is_deleted=0 ORDER BY created_at DESC", [cid]),
    quotations: db.rows("SELECT id, quotation_no, amount, status, valid_until FROM quotation WHERE customer_id=? AND is_deleted=0 ORDER BY created_at DESC", [cid]),
    amount: amount_summary_of_customer(cid),
  };
});

function amount_summary_of_customer(cid) {
  const cs = db.rows("SELECT id, amount, amount_type FROM contract WHERE customer_id=? AND is_deleted=0", [cid]);
  let total = 0, paid = 0;
  for (const c of cs) {
    if (c.amount_type === "不适用") continue;
    total += db.to_cents(c.amount);
    paid += db.to_cents(db.amount_summary(c.id).paid_amount || 0);
  }
  return { contract_total: db.fmt_money(total), paid_total: db.fmt_money(paid), unpaid_total: db.fmt_money(total - paid) };
}

route("PATCH", "customers/:cid", (p) => {
  const cid = p.params.cid, b = p.body;
  const c = db.one("SELECT * FROM customer WHERE id=? AND is_deleted=0", [cid]);
  if (!c) fail(40101, "客户不存在");
  const allowed = ["name", "credit_code", "contact_name", "contact_phone", "address", "invoice_title",
    "invoice_tax_no", "invoice_bank", "invoice_account", "owner_id", "remark"];
  const sets = [], vals = [], before = {};
  for (const k of allowed) {
    if (k in b) {
      if (k === "name" && db.one("SELECT id FROM customer WHERE lower(name)=lower(?) AND is_deleted=0 AND id<>?", [b[k], cid])) fail(40901, "客户名称已存在", "name");
      before[k] = c[k];
      sets.push(`${k}=?`); vals.push(b[k]);
    }
  }
  if (sets.length) {
    sets.push("updated_at=?", "updated_by=?");
    vals.push(db.now_iso(), db.current_operator_id(), cid);
    db.run(`UPDATE customer SET ${sets.join(", ")} WHERE id=?`, vals);
  }
  return { id: cid, changed: before };
});

route("DELETE", "customers/:cid", (p) => {
  const cid = p.params.cid;
  const n = parseInt(db.scalar("SELECT (SELECT COUNT(*) FROM contract WHERE customer_id=? AND is_deleted=0) + (SELECT COUNT(*) FROM quotation WHERE customer_id=? AND is_deleted=0)", [cid, cid]) || 0, 10);
  if (n) fail(40903, `该客户存在 ${n} 条关联数据，无法删除`);
  db.run("UPDATE customer SET is_deleted=1, deleted_at=? WHERE id=?", [db.now_iso(), cid]);
  return null;
});

// ---------- 报价单 ----------
route("GET", "quotations", (p) => {
  let sql = "SELECT q.*, u.name AS customer_name, o.name AS owner_name,"
    + " (SELECT contract_no FROM contract x WHERE x.source_quotation_id=q.id AND x.is_deleted=0 LIMIT 1) AS converted_contract_no"
    + " FROM quotation q JOIN customer u ON u.id=q.customer_id LEFT JOIN operator o ON o.id=q.owner_id WHERE q.is_deleted=0";
  const ps = [];
  if (p.q.customer_id) { sql += " AND q.customer_id=?"; ps.push(p.q.customer_id); }
  if (p.q.status) { sql += " AND q.status=?"; ps.push(p.q.status); }
  if (p.q.owner_id) { sql += " AND q.owner_id=?"; ps.push(p.q.owner_id); }
  if (p.q.keyword) { sql += " AND (q.quotation_no LIKE ? OR u.name LIKE ?)"; ps.push(`%${p.q.keyword}%`, `%${p.q.keyword}%`); }
  return page_of(db.rows(sql + " ORDER BY q.created_at DESC", ps), p.page, p.size);
});

route("GET", "quotations/:qid", (p) => {
  const qid = p.params.qid;
  const q = db.one("SELECT q.*, u.name AS customer_name, o.name AS owner_name FROM quotation q JOIN customer u ON u.id=q.customer_id LEFT JOIN operator o ON o.id=q.owner_id WHERE q.id=? AND q.is_deleted=0", [qid]);
  if (!q) fail(40101, "报价单不存在");
  return {
    quotation: q,
    items: db.rows("SELECT * FROM quotation_item WHERE quotation_id=? AND is_deleted=0 ORDER BY sort_no", [qid]),
    versions: db.rows("SELECT version_no, amount, change_summary, created_at FROM quotation_version WHERE quotation_id=? ORDER BY created_at DESC", [qid]),
    converted_contract: db.one("SELECT id, contract_no, name, status FROM contract WHERE source_quotation_id=? AND is_deleted=0", [qid]),
    attachments: db.rows("SELECT * FROM attachment WHERE object_type='QUOTATION' AND object_id=? AND is_deleted=0 ORDER BY uploaded_at DESC", [qid]),
    allowed_transitions: TRANSITIONS.QUOTATION[q.status] || [],
  };
});

route("POST", "quotations", (p) => {
  const b = p.body;
  const cidIn = b.customer_id;
  if (!cidIn || !db.one("SELECT id FROM customer WHERE id=? AND is_deleted=0", [cidIn])) fail(40101, "客户不存在", "customer_id");
  const items = b.items || [];
  let amount = b.amount;
  if (amount === null || amount === undefined) amount = db.fmt_money(items.reduce((s, i) => s + db.to_cents(i.amount || 0), 0));
  const op = db.current_operator_id();
  const qid = db.new_id();
  const no = db.next_no("BJ");
  db.run("INSERT INTO quotation(id,quotation_no,customer_id,amount,currency,valid_until,payment_terms,status,owner_id,current_version_no,remark,created_at,created_by,updated_at,updated_by) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [qid, no, cidIn, amount, b.currency || "CNY",
      b.valid_until || db.days_ahead(14), b.payment_terms ?? null, b.status || "草稿", b.owner_id || op, "V1.0",
      b.remark ?? null, db.now_iso(), op, db.now_iso(), op]);
  items.forEach((it, i) => {
    const qty = String(it.quantity ?? 1), up = String(it.unit_price ?? 0);
    const amt = it.amount || db.fmt_money(Math.trunc(parseFloat(qty) * db.to_cents(up)));
    db.run("INSERT INTO quotation_item(id,quotation_id,name,spec,quantity,unit_price,amount,sort_no,is_deleted) VALUES(?,?,?,?,?,?,?,?,0)",
      [db.new_id(), qid, it.name || "未命名", it.spec ?? null, qty, up, amt, i]);
  });
  db.run("INSERT INTO quotation_version(id,quotation_id,version_no,amount,items_snapshot,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
    [db.new_id(), qid, "V1.0", amount, JSON.stringify(items), "初始版本", op, db.now_iso()]);
  return { id: qid, quotation_no: no };
});

route("POST", ":obj/:oid/status-transitions", (p) => {
  const { obj, oid } = p.params;
  if (obj !== "contracts" && obj !== "quotations") fail(40101, "对象不存在");
  const kind = obj === "contracts" ? "CONTRACT" : "QUOTATION";
  const table = kind === "CONTRACT" ? "contract" : "quotation";
  const to = p.body.to_status;
  const row = db.one(`SELECT * FROM ${table} WHERE id=? AND is_deleted=0`, [oid]);
  if (!row) fail(40101, "对象不存在");
  if (!(TRANSITIONS[kind][row.status] || []).includes(to)) fail(40301, `不允许从「${row.status}」推进到「${to}」`);
  engine._advance(kind, oid, to, db.current_operator_id(), p.body.remark, "手动");
  return { id: oid, status: to, allowed_transitions: TRANSITIONS[kind][to] || [] };
});

route("POST", "quotations/:qid/convert-to-contract", (p) => {
  const qid = p.params.qid, b = p.body;
  const op = db.current_operator_id();
  const q = db.one("SELECT * FROM quotation WHERE id=? AND is_deleted=0", [qid]);
  if (!q) fail(40101, "报价单不存在");
  if (q.status === "已转合同") fail(40904, "该报价单已转过合同");
  if (q.status === "已作废" || q.status === "已失效") fail(40904, `报价单处于「${q.status}」状态，不可转合同`);
  const custName = (db.one("SELECT name FROM customer WHERE id=?", [q.customer_id]) || {}).name;
  const name = b.name || `${custName} ${q.quotation_no} 合同`;
  const cid = db.new_id();
  const no = db.next_no("HT");
  db.run("INSERT INTO contract(id,contract_no,name,contract_type,customer_id,amount,amount_type,currency,"
    + "service_start_date,service_end_date,sign_date,planned_delivery_date,auto_renewal,source_quotation_id,"
    + "payment_terms,status,owner_id,current_version_no,created_at,created_by,updated_at,updated_by) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [cid, no, name, b.contract_type || "服务合同", q.customer_id, q.amount,
      b.amount_type || "合同总额", "CNY",
      b.service_start_date || db.today_str(),
      b.service_end_date || db.days_ahead(365),
      b.sign_date ?? null, b.planned_delivery_date ?? null, b.auto_renewal ? 1 : 0,
      qid, q.payment_terms, "草稿", q.owner_id || op, "V1.0", db.now_iso(), op, db.now_iso(), op]);
  const items = db.rows("SELECT * FROM quotation_item WHERE quotation_id=? AND is_deleted=0 ORDER BY sort_no", [qid]);
  for (const it of items) {
    db.run("INSERT INTO contract_item(id,contract_id,name,spec,quantity,unit_price,amount,sort_no,is_deleted) VALUES(?,?,?,?,?,?,?,?,0)",
      [db.new_id(), cid, it.name, it.spec, it.quantity, it.unit_price, it.amount, it.sort_no]);
  }
  for (const pl of b.payment_plans || []) {
    db.run("INSERT INTO contract_payment_plan(id,contract_id,seq_no,plan_amount,due_date,remark,created_at,is_deleted) VALUES(?,?,?,?,?,?,?,0)",
      [db.new_id(), cid, parseInt(pl.seq_no || 1, 10), String(pl.plan_amount), pl.due_date ?? null, pl.remark ?? null, db.now_iso()]);
  }
  db.run("INSERT INTO contract_version(id,contract_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
    [db.new_id(), cid, "V1.0", `【合同名称】${name}\n【来源报价单】${q.quotation_no}\n【金额】${q.amount} 元\n\n（由报价单转入，正文可编辑后创建新版本）`,
      "由报价单转入", op, db.now_iso()]);
  engine._advance("QUOTATION", qid, "已转合同", op, "报价转合同", "手动");
  return { contract_id: cid, contract_no: no, items_copied: items.length };
});

// ---------- 合同 ----------
route("GET", "contracts", (p) => {
  let sql = "SELECT c.*, u.name AS customer_name, o.name AS owner_name FROM contract c JOIN customer u ON u.id=c.customer_id LEFT JOIN operator o ON o.id=c.owner_id WHERE c.is_deleted=0 AND c.is_archived=?";
  const ps = [toBool(p.q.is_archived) ? 1 : 0];
  if (p.q.customer_id) { sql += " AND c.customer_id=?"; ps.push(p.q.customer_id); }
  if (p.q.contract_type) { sql += " AND c.contract_type=?"; ps.push(p.q.contract_type); }
  if (p.q.status) { const arr = String(p.q.status).split(","); sql += ` AND c.status IN (${arr.map(() => "?").join(",")})`; ps.push(...arr); }
  if (p.q.owner_id) { sql += " AND c.owner_id=?"; ps.push(p.q.owner_id); }
  if (p.q.keyword) { sql += " AND (c.contract_no LIKE ? OR c.name LIKE ? OR u.name LIKE ?)"; ps.push(`%${p.q.keyword}%`, `%${p.q.keyword}%`, `%${p.q.keyword}%`); }
  if (p.q.sign_date_min) { sql += " AND c.sign_date >= ?"; ps.push(p.q.sign_date_min); }
  if (p.q.sign_date_max) { sql += " AND c.sign_date <= ?"; ps.push(p.q.sign_date_max); }
  const items = db.rows(sql + " ORDER BY c.created_at DESC", ps);
  const out = [];
  for (const c of items) {
    if (p.q.amount_min && db.to_cents(c.amount || 0) < db.to_cents(p.q.amount_min)) continue;
    if (p.q.amount_max && db.to_cents(c.amount || 0) > db.to_cents(p.q.amount_max)) continue;
    c.amount_summary = db.amount_summary(c.id);
    out.push(c);
  }
  return page_of(out, p.page, p.size);
});

route("GET", "contracts/:cid", (p) => {
  const cid = p.params.cid;
  const c = db.one("SELECT c.*, u.name AS customer_name, o.name AS owner_name FROM contract c JOIN customer u ON u.id=c.customer_id LEFT JOIN operator o ON o.id=c.owner_id WHERE c.id=? AND c.is_deleted=0", [cid]);
  if (!c) fail(40101, "合同不存在");
  const pl = db.allocate_payments(cid);
  const f = db.one(`SELECT * FROM (${proc._CONTRACT_FACT}) t WHERE t.contract_id=?`, [cid]);
  const st = f ? proc._stages(f) : {};
  const cur = f ? proc._current_stage(f, st) : null;
  return {
    contract: c,
    items: db.rows("SELECT * FROM contract_item WHERE contract_id=? AND is_deleted=0 ORDER BY sort_no", [cid]),
    payment_plans: pl.plans,
    has_overpayment: pl.has_overpayment,
    versions: db.rows("SELECT version_no, change_summary, created_at, substr(content,1,200) AS preview FROM contract_version WHERE contract_id=? ORDER BY created_at DESC", [cid]),
    current_version: db.one("SELECT version_no, content FROM contract_version WHERE contract_id=? ORDER BY created_at DESC LIMIT 1", [cid]),
    attachments: db.rows("SELECT * FROM attachment WHERE object_type='CONTRACT' AND object_id=? AND is_deleted=0 ORDER BY uploaded_at DESC", [cid]),
    deliveries: db.rows("SELECT * FROM delivery WHERE contract_id=? AND is_deleted=0 ORDER BY ship_date DESC", [cid]),
    acceptances: db.rows("SELECT * FROM acceptance WHERE contract_id=? AND is_deleted=0 ORDER BY accept_date DESC", [cid]),
    invoices: db.rows("SELECT * FROM invoice WHERE contract_id=? AND is_deleted=0 ORDER BY invoice_date DESC", [cid]),
    payments: db.rows("SELECT * FROM payment WHERE contract_id=? AND is_deleted=0 ORDER BY received_date DESC", [cid]),
    status_logs: db.rows("SELECT s.*, o.name AS operator_name FROM status_log s LEFT JOIN operator o ON o.id=s.changed_by WHERE s.object_type='CONTRACT' AND s.object_id=? ORDER BY s.changed_at DESC", [cid]),
    amount_summary: db.amount_summary(cid),
    process_stage: { current_stage: cur, stages: st },
    allowed_transitions: TRANSITIONS.CONTRACT[c.status] || [],
    source_quotation: c.source_quotation_id ? db.one("SELECT id, quotation_no, amount FROM quotation WHERE id=?", [c.source_quotation_id]) : null,
    template: c.template_id ? db.one("SELECT id, name FROM contract_template WHERE id=?", [c.template_id]) : null,
  };
});

route("POST", "contracts", (p) => {
  const b = p.body;
  const custId = b.customer_id;
  if (!custId || !db.one("SELECT id FROM customer WHERE id=? AND is_deleted=0", [custId])) fail(40101, "客户不存在", "customer_id");
  const op = db.current_operator_id();
  const cid = db.new_id();
  const no = db.next_no("HT");
  db.run("INSERT INTO contract(id,contract_no,name,contract_type,customer_id,amount,amount_type,currency,"
    + "service_start_date,service_end_date,sign_date,planned_delivery_date,auto_renewal,template_id,"
    + "payment_terms,status,owner_id,current_version_no,remark,created_at,created_by,updated_at,updated_by) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [cid, no, b.name || "未命名合同", b.contract_type || "服务合同", custId,
      b.amount ?? null, b.amount_type || (b.amount ? "合同总额" : "不适用"), "CNY",
      b.service_start_date || db.today_str(), b.service_end_date || db.days_ahead(365),
      b.sign_date ?? null, b.planned_delivery_date ?? null, b.auto_renewal ? 1 : 0, b.template_id ?? null,
      b.payment_terms ?? null, "草稿", b.owner_id || op, "V1.0", b.remark ?? null, db.now_iso(), op, db.now_iso(), op]);
  if (b.content) {
    db.run("INSERT INTO contract_version(id,contract_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [db.new_id(), cid, "V1.0", b.content, "初始版本", op, db.now_iso()]);
  }
  return { id: cid, contract_no: no };
});

route("PATCH", "contracts/:cid", (p) => {
  const cid = p.params.cid, b = p.body;
  const c = db.one("SELECT * FROM contract WHERE id=? AND is_deleted=0", [cid]);
  if (!c) fail(40101, "合同不存在");
  if (c.status === "已作废") fail(40904, "已作废的合同不可编辑");
  if (("amount" in b) && (c.status === "履行中" || c.status === "已到期") && String(b.amount) !== String(c.amount || "")) {
    fail(42203, "已生效合同的金额变更需记录变更原因，请通过详情页操作", "amount");
  }
  const sets = [], vals = [], before = {};
  for (const k of engine.UPDATABLE.contract) {
    if (k in b) {
      let v = b[k];
      if (["sign_date", "service_start_date", "service_end_date", "planned_delivery_date"].includes(k) && (v === "" || v === null)) v = null;
      before[k] = c[k];
      sets.push(`${k}=?`);
      vals.push(k === "auto_renewal" ? (v ? 1 : 0) : v);
    }
  }
  if (sets.length) {
    sets.push("updated_at=?", "updated_by=?");
    vals.push(db.now_iso(), db.current_operator_id(), cid);
    db.run(`UPDATE contract SET ${sets.join(", ")} WHERE id=?`, vals);
  }
  return { id: cid, changed: before };
});

route("DELETE", "contracts/:cid", (p) => {
  const cid = p.params.cid;
  const n = parseInt(db.scalar("SELECT (SELECT COUNT(*) FROM delivery WHERE contract_id=? AND is_deleted=0)"
    + " + (SELECT COUNT(*) FROM acceptance WHERE contract_id=? AND is_deleted=0)"
    + " + (SELECT COUNT(*) FROM invoice WHERE contract_id=? AND is_deleted=0)"
    + " + (SELECT COUNT(*) FROM payment WHERE contract_id=? AND is_deleted=0)", [cid, cid, cid, cid]) || 0, 10);
  if (n) fail(40903, `该合同存在 ${n} 条履约记录，无法删除`);
  db.run("UPDATE contract SET is_deleted=1, deleted_at=? WHERE id=?", [db.now_iso(), cid]);
  return null;
});

route("POST", "contracts/:cid/archive", (p) => { db.run("UPDATE contract SET is_archived=1 WHERE id=?", [p.params.cid]); return { archived: true }; });
route("DELETE", "contracts/:cid/archive", (p) => { db.run("UPDATE contract SET is_archived=0 WHERE id=?", [p.params.cid]); return { archived: false }; });

route("POST", "contracts/:cid/versions", (p) => {
  const cid = p.params.cid;
  const c = db.one("SELECT current_version_no FROM contract WHERE id=?", [cid]);
  if (!c) fail(40101, "合同不存在");
  const nxt = engine._bump(c.current_version_no);
  db.run("INSERT INTO contract_version(id,contract_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
    [db.new_id(), cid, nxt, p.body.content || "", p.body.change_summary ?? null, db.current_operator_id(), db.now_iso()]);
  db.run("UPDATE contract SET current_version_no=?, updated_at=? WHERE id=?", [nxt, db.now_iso(), cid]);
  return { version_no: nxt };
});

route("GET", "contracts/:cid/status-logs", (p) =>
  db.rows("SELECT s.*, o.name AS operator_name FROM status_log s LEFT JOIN operator o ON o.id=s.changed_by WHERE s.object_type='CONTRACT' AND s.object_id=? ORDER BY s.changed_at DESC", [p.params.cid]));

// ---------- 付款计划 ----------
route("GET", "contracts/:cid/payment-plans", (p) => db.allocate_payments(p.params.cid));
route("POST", "contracts/:cid/payment-plans", (p) => {
  const cid = p.params.cid;
  db.run("INSERT INTO contract_payment_plan(id,contract_id,seq_no,plan_amount,due_date,remark,created_at,is_deleted) VALUES(?,?,?,?,?,?,?,0)",
    [db.new_id(), cid, parseInt(p.body.seq_no || 1, 10), String(p.body.plan_amount), p.body.due_date ?? null, p.body.remark ?? null, db.now_iso()]);
  return db.allocate_payments(cid);
});
route("DELETE", "payment-plans/:pid", (p) => { db.run("UPDATE contract_payment_plan SET is_deleted=1 WHERE id=?", [p.params.pid]); return null; });

// ---------- 履约记录（交付 / 验收 / 开票 / 回款） ----------
for (const [kind, cfg] of Object.entries(RECORDS)) {
  route("GET", `contracts/:cid/${cfg.plural}`, (p) =>
    db.rows(`SELECT * FROM ${kind} WHERE contract_id=? AND is_deleted=0 ORDER BY created_at DESC`, [p.params.cid]));

  route("POST", `contracts/:cid/${cfg.plural}`, (p) => {
    const cid = p.params.cid;
    if (!db.one("SELECT id FROM contract WHERE id=? AND is_deleted=0", [cid])) fail(40101, "合同不存在");
    const data = { ...cfg.defaults };
    for (const [k, v] of Object.entries(p.body)) if (cfg.fields.includes(k)) data[k] = v;
    for (const req of cfg.fields.slice(0, 3)) {
      if (data[req] === null || data[req] === undefined || data[req] === "") {
        if (["content", "ship_date", "accept_date", "invoice_no", "invoice_date", "amount", "received_date"].includes(req)) fail(40002, `缺少必填字段 ${req}`, req);
      }
    }
    const rid = db.new_id();
    const op = db.current_operator_id();
    const cols = [...Object.keys(data), "id", "contract_id", "created_at", "created_by", "updated_at", "is_deleted"];
    const vals = [...Object.values(data), rid, cid, db.now_iso(), op, db.now_iso(), 0];
    db.run(`INSERT INTO ${kind}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, vals);
    const out = { id: rid };
    if (kind === "payment") { out.allocation = db.allocate_payments(cid); out.amount_summary = db.amount_summary(cid); }
    return out;
  });

  route("PATCH", `${cfg.plural}/:rid`, (p) => {
    const rid = p.params.rid;
    if (!db.one(`SELECT id FROM ${kind} WHERE id=? AND is_deleted=0`, [rid])) fail(40101, "记录不存在");
    const sets = [], vals = [];
    for (const k of cfg.fields) if (k in p.body) { sets.push(`${k}=?`); vals.push(p.body[k]); }
    if (sets.length) { sets.push("updated_at=?"); vals.push(db.now_iso(), rid); db.run(`UPDATE ${kind} SET ${sets.join(", ")} WHERE id=?`, vals); }
    return { id: rid };
  });

  route("DELETE", `${cfg.plural}/:rid`, (p) => { db.run(`UPDATE ${kind} SET is_deleted=1 WHERE id=?`, [p.params.rid]); return null; });
}

// ---------- 合同模板 ----------
route("GET", "templates", (p) => {
  let sql = "SELECT * FROM contract_template WHERE is_deleted=0";
  const ps = [];
  if (p.q.template_type) { sql += " AND template_type=?"; ps.push(p.q.template_type); }
  if (p.q.status) { sql += " AND status=?"; ps.push(p.q.status); }
  const items = db.rows(sql + " ORDER BY created_at", ps);
  for (const it of items) {
    try { it.variables = JSON.parse(it.variables || "[]"); } catch { it.variables = []; }
  }
  return { list: items, total: items.length };
});

// 注意：必须注册在 templates/:tid 之前，否则 "types" 会被当成 tid 吃掉
route("GET", "templates/types", () => ({
  types: ["报价单", "销售合同", "服务合同", "保密协议", "其他"],
  doc_kinds: [...DOC_KINDS],
}));

route("GET", "templates/:tid", (p) => {
  const tid = p.params.tid;
  const t = db.one("SELECT * FROM contract_template WHERE id=? AND is_deleted=0", [tid]);
  if (!t) fail(40101, "模板不存在");
  try { t.variables = JSON.parse(t.variables || "[]"); } catch { t.variables = []; }
  const ver = db.one("SELECT * FROM contract_template_version WHERE template_id=? ORDER BY created_at DESC LIMIT 1", [tid]);
  return { template: t, version_no: ver ? ver.version_no : null, content: ver ? ver.content : "" };
});

route("POST", "templates/:tid/parse-variables", (p) => {
  const content = p.body.content || "";
  const keys = Array.from(new Set((content.match(/\{\{(.+?)\}\}/g) || []).map(s => s.slice(2, -2)))).sort();
  const mapping = {
    "客户名称": ["scalar", "customer.name"], "统一社会信用代码": ["scalar", "customer.credit_code"],
    "联系人": ["scalar", "customer.contact_name"], "电话": ["scalar", "customer.contact_phone"],
    "地址": ["scalar", "customer.address"], "报价单编号": ["scalar", "quotation.quotation_no"],
    "报价日期": ["scalar", "quotation.created_at"], "有效期": ["scalar", "quotation.valid_until"],
    "报价金额": ["scalar", "quotation.amount"], "付款条件": ["scalar", "contract.payment_terms"],
    "合同编号": ["scalar", "contract.contract_no"], "合同名称": ["scalar", "contract.name"],
    "合同金额": ["scalar", "contract.amount"], "服务开始日期": ["scalar", "contract.service_start_date"],
    "服务结束日期": ["scalar", "contract.service_end_date"], "签署日期": ["scalar", "contract.sign_date"],
    "约定交付日期": ["scalar", "contract.planned_delivery_date"], "违约金比例": ["scalar", "手工填写"],
    "乙方名称": ["scalar", "app_setting.company_name"], "服务目标": ["scalar", "手工填写"],
    "服务内容": ["scalar", "手工填写"], "保密年限": ["scalar", "手工填写"],
    "明细表": ["table", "quotation_item | contract_item"],
  };
  const variables = [], unknown = [];
  for (const k of keys) {
    if (mapping[k]) variables.push({ key: k, type: mapping[k][0], source: mapping[k][1], label: k });
    else unknown.push(k);
  }
  return { variables, unknown };
});

// ---------- 业务进程 ----------
route("GET", "processes", (p) => {
  const items = proc.list_processes({
    stage: p.q.stage || undefined, owner_id: p.q.owner_id || undefined, customer_id: p.q.customer_id || undefined,
    keyword: p.q.keyword || undefined, amount_min: p.q.amount_min || undefined, amount_max: p.q.amount_max || undefined,
    stagnant_only: toBool(p.q.stagnant_only), include_closed: toBool(p.q.include_closed),
  });
  const board = {};
  for (const k of ["报价", "签约", "交付", "验收", "开票", "回款", "完结"]) board[k] = [];
  for (const it of items) (board[it.current_stage] || (board[it.current_stage] = [])).push(it);
  return { summary: proc.summary(), board, list: items, total: items.length };
});

route("GET", "processes/:pid", (p) => {
  const all = proc.list_processes({ include_closed: true });
  const found = all.find(x => x.process_id === p.params.pid);
  if (!found) fail(40101, "业务进程不存在");
  return { process: found, timeline: proc.timeline(p.params.pid), contract_id: found.contract_id };
});

// ---------- 提醒 ----------
route("GET", "reminders", (p) => {
  let sql = "SELECT r.*,"
    + "       CASE WHEN r.object_type='CONTRACT' THEN c.contract_no ELSE q.quotation_no END AS target_no,"
    + "       c.name AS target_name,"
    + "       COALESCE(cu.name, qu.name) AS customer_name,"
    + "       COALESCE(c.id, q.id) AS target_exists"
    + "  FROM reminder r"
    + "  LEFT JOIN contract  c  ON r.object_type='CONTRACT'  AND c.id = r.object_id"
    + "  LEFT JOIN customer  cu ON cu.id = c.customer_id"
    + "  LEFT JOIN quotation q  ON r.object_type='QUOTATION' AND q.id = r.object_id"
    + "  LEFT JOIN customer  qu ON qu.id = q.customer_id"
    + " WHERE 1=1";
  const ps = [];
  if (p.q.is_read !== undefined && p.q.is_read !== "") { sql += " AND r.is_read=?"; ps.push(toBool(p.q.is_read) ? 1 : 0); }
  if (p.q.remind_type) { sql += " AND r.remind_type=?"; ps.push(p.q.remind_type); }
  const items = db.rows(sql + " ORDER BY r.is_read, r.triggered_at DESC", ps);
  return { list: items, unread: items.filter(r => !r.is_read).length };
});

route("PATCH", "reminders/:rid/read", (p) => {
  db.run("UPDATE reminder SET is_read=1, read_at=? WHERE id=?", [db.now_iso(), p.params.rid]);
  return { id: p.params.rid };
});

route("POST", "reminders/read-all", () => {
  const n = parseInt(db.scalar("SELECT COUNT(*) FROM reminder WHERE is_read=0") || 0, 10);
  db.run("UPDATE reminder SET is_read=1, read_at=? WHERE is_read=0", [db.now_iso()]);
  return { updated: n };
});

route("POST", "reminders/scan", () => tasks.run_all());

// ---------- 操作日志 ----------
route("GET", "operation-logs", (p) => {
  const limit = parseInt(p.q.limit || 50, 10);
  return db.rows("SELECT l.*, o.name AS operator_name FROM operation_log l LEFT JOIN operator o ON o.id=l.operator_id ORDER BY l.created_at DESC LIMIT ?", [limit]);
});

// ---------- 智能助手 ----------
route("POST", "assistant/conversations", (p) => {
  const cid = db.new_id();
  db.run("INSERT INTO chat_conversation(id,title,context,entity_stack,created_at) VALUES(?,?,?,?,?)",
    [cid, p.body.title || "新对话", JSON.stringify(p.body.context || {}), "[]", db.now_iso()]);
  engine.resetSession();
  return { id: cid };
});

route("GET", "assistant/conversations", () =>
  db.rows("SELECT c.*, (SELECT COUNT(*) FROM chat_message m WHERE m.conversation_id=c.id) AS msg_count FROM chat_conversation c ORDER BY created_at DESC LIMIT 30"));

route("GET", "assistant/conversations/:cid/messages", (p) =>
  db.rows("SELECT * FROM chat_message WHERE conversation_id=? ORDER BY created_at", [p.params.cid]));

route("POST", "assistant/conversations/:cid/messages", async (p) => {
  const cid = p.params.cid;
  const text = String(p.body.content || "").trim();
  if (!text) fail(40002, "消息不能为空", "content");
  const conv = db.one("SELECT * FROM chat_conversation WHERE id=?", [cid]);
  if (!conv) fail(40101, "会话不存在");
  let context = p.body.context;
  if (!context) { try { context = JSON.parse(conv.context || "{}"); } catch { context = {}; } }
  save_message(cid, "user", text, null);
  const out = await engine.handle(text, context);
  // events 和 entities 一起存 —— 只存 events 的话，刷新页面后回答里的
  // 「可点击跳转」入口会全部丢失，用户就得重新问一遍。
  save_message(cid, "assistant", out.reply || "", { events: out.events || [], entities: out.entities || [] });
  let stack = [];
  try { stack = JSON.parse((db.one("SELECT entity_stack FROM chat_conversation WHERE id=?", [cid]) || {}).entity_stack || "[]"); } catch { stack = []; }
  for (const e of out.entities || []) stack.push({ type: e.type, id: e.id, label: e.label || "" });
  db.run("UPDATE chat_conversation SET entity_stack=? WHERE id=?", [JSON.stringify(stack.slice(-20)), cid]);
  return out;
});

function save_message(cid, role, content, payload) {
  db.run("INSERT INTO chat_message(id,conversation_id,role,content,payload,created_at) VALUES(?,?,?,?,?,?)",
    [db.new_id(), cid, role, content, payload ? JSON.stringify(payload) : null, db.now_iso()]);
}

route("POST", "assistant/actions/:aid/confirm", async (p) => {
  const out = await engine.confirmAction(p.params.aid);
  if (!out.ok) fail(42204, out.reply || "确认失败");
  return out;
});

route("POST", "assistant/actions/:aid/cancel", (p) => engine.cancelAction(p.params.aid));

route("POST", "assistant/actions/:aid/undo", async (p) => {
  const out = await engine.undo(p.params.aid);
  if (!out.ok) fail(42204, out.reply || "撤销失败");
  return out;
});

route("GET", "assistant/pending-actions", () =>
  db.rows("SELECT id, action_type, level, card, status, created_at, expires_at FROM pending_action ORDER BY created_at DESC LIMIT 20"));

// ---------------- 调度入口 ----------------
export async function apiLocal(path, opt = {}) {
  const method = (opt.method || "GET").toUpperCase();
  const [pathname, qs] = String(path).split("?");
  const segs = pathname.split("/").filter(Boolean);
  const q = {};
  for (const [k, v] of new URLSearchParams(qs || "")) q[k] = v;

  for (const r of ROUTES) {
    if (r.method !== method || r.segs.length !== segs.length) continue;
    const params = {};
    let hit = true;
    for (let i = 0; i < r.segs.length; i++) {
      const ps = r.segs[i];
      if (ps.startsWith(":")) params[ps.slice(1)] = decodeURIComponent(segs[i]);
      else if (ps !== segs[i]) { hit = false; break; }
    }
    if (!hit) continue;
    const page = parseInt(q.page || 1, 10) || 1;
    const size = parseInt(q.page_size || 20, 10) || 20;
    return await r.handler({ params, q, body: opt.body || {}, page, size });
  }
  fail(40401, `接口不存在：${method} ${pathname}`);
}

// ================= 浏览器专属：附件存储 =================
const FILE_DB = "bizflow_files";
const FILE_STORE = "files";

function fileOpen() {
  return new Promise((resolve) => {
    const req = indexedDB.open(FILE_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(FILE_STORE)) req.result.createObjectStore(FILE_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function filePut(key, bytes) {
  const h = await fileOpen(); if (!h) return;
  await new Promise((resolve) => {
    const tx = h.transaction(FILE_STORE, "readwrite");
    tx.objectStore(FILE_STORE).put(bytes, key);
    tx.oncomplete = tx.onerror = tx.onabort = () => { h.close(); resolve(); };
  });
}

async function fileGet(key) {
  const h = await fileOpen(); if (!h) return null;
  return await new Promise((resolve) => {
    const tx = h.transaction(FILE_STORE, "readonly");
    const g = tx.objectStore(FILE_STORE).get(key);
    g.onsuccess = () => { h.close(); resolve(g.result || null); };
    g.onerror = () => { h.close(); resolve(null); };
  });
}

const EXT_MIME = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** 保存上传文件（对应后端 _save_uploads）。files 为 File 数组。 */
async function saveUploads(objectType, objectId, files, docKind) {
  if (!db.one(`SELECT id FROM ${OBJ_TABLE[objectType]} WHERE id=? AND is_deleted=0`, [objectId])) {
    fail(40101, "关联对象不存在");
  }
  const saved = [], rejected = [];
  for (const f of files) {
    const name = f.name || "未命名";
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (!["pdf", "jpg", "jpeg", "png", "doc", "docx"].includes(ext)) {
      rejected.push({ file: name, reason: "仅支持 PDF / JPG / PNG / DOC / DOCX" });
      continue;
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    if (buf.length > 50 * 1024 * 1024) {
      rejected.push({ file: name, reason: "单文件不能超过 50MB" });
      continue;
    }
    const aid = db.new_id();
    await filePut(aid, buf);
    db.run("INSERT INTO attachment(id,object_type,object_id,file_name,file_type,file_path,file_size,doc_kind,join_ai_qa,uploaded_by,uploaded_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,0,?,?,0)",
      [aid, objectType, objectId, name, ext, aid, buf.length, docKind, db.current_operator_id(), db.now_iso()]);
    saved.push({ id: aid, file_name: name, doc_kind: docKind, size: buf.length });
  }
  return { ok: true, saved, rejected, note: "附件不参与 AI 条款问答（MVP 不做 OCR），条款问答以合同正文为准" };
}

/** 上传附件（合同 / 报价单）。 */
export async function uploadAttachments(objectType, objectId, docKind, files) {
  return saveUploads(objectType, objectId, files, docKind);
}

/** 批量导入盖章扫描件（对应 POST /imports/scans）。 */
export async function importScans(objectType, objectId, docKind, advanceTo, files) {
  if (!OBJ_TABLE[objectType]) fail(40003, "object_type 只能是 CONTRACT 或 QUOTATION", "object_type");
  if (!DOC_KINDS.includes(docKind)) fail(40003, `doc_kind 只能是 ${DOC_KINDS.join("/")}`, "doc_kind");
  if (advanceTo && objectType === "CONTRACT") {
    const cur = (db.one("SELECT status FROM contract WHERE id=? AND is_deleted=0", [objectId]) || {}).status;
    if (!(TRANSITIONS.CONTRACT[cur] || []).includes(advanceTo)) fail(40301, `不允许从「${cur}」推进到「${advanceTo}」`, "advance_to");
  }
  const r = await saveUploads(objectType, objectId, files, docKind);
  let advanced = null;
  if (advanceTo && r.saved.length) {
    engine._advance("CONTRACT", objectId, advanceTo, db.current_operator_id(), "导入盖章扫描件后推进", "手动");
    advanced = advanceTo;
  }
  return { saved: r.saved, rejected: r.rejected, advanced_to: advanced, count: r.saved.length, note: r.note };
}

/** 删除附件（对应 DELETE /attachments/{aid}）。 */
export async function deleteAttachment(aid) {
  db.run("UPDATE attachment SET is_deleted=1 WHERE id=?", [aid]);
  return null;
}

// ================= 浏览器专属：文件下载 =================
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 下载附件（对应 GET /attachments/{aid}/download）。 */
export async function downloadAttachment(aid) {
  const a = db.one("SELECT * FROM attachment WHERE id=? AND is_deleted=0", [aid]);
  if (!a) fail(40101, "附件不存在");
  const bytes = await fileGet(a.file_path);
  if (!bytes) fail(40101, "附件内容已丢失（可能清除了浏览器数据）");
  triggerDownload(new Blob([bytes], { type: EXT_MIME[a.file_type] || "application/octet-stream" }), a.file_name);
}

/** 导出报价单文档（对应 GET /quotations/{qid}/document）。format: docx | print */
export function exportQuotationDocument(qid, format = "docx", templateId = null) {
  const q = db.one("SELECT * FROM quotation WHERE id=? AND is_deleted=0", [qid]);
  if (!q) fail(40101, "报价单不存在");
  const blocks = docs.quotation_blocks(q, templateId);
  const title = `报价单 ${q.quotation_no}`;
  if (format === "print") {
    const w = window.open("", "_blank");
    if (!w) fail(50001, "浏览器拦截了新窗口，请允许弹出窗口后重试");
    w.document.write(docs.to_print_html(title, blocks, "浏览器打印 → 另存为 PDF"));
    w.document.close();
    return;
  }
  triggerDownload(new Blob([docs.to_docx(title, blocks)], { type: EXT_MIME.docx }), `${q.quotation_no}.docx`);
}

/** 导出合同文档（对应 GET /contracts/{cid}/document）。format: docx | print */
export function exportContractDocument(cid, format = "docx", versionNo = null) {
  const c = db.one("SELECT * FROM contract WHERE id=? AND is_deleted=0", [cid]);
  if (!c) fail(40101, "合同不存在");
  const blocks = docs.contract_blocks(c, versionNo);
  const title = `合同 ${c.contract_no}`;
  if (format === "print") {
    const w = window.open("", "_blank");
    if (!w) fail(50001, "浏览器拦截了新窗口，请允许弹出窗口后重试");
    w.document.write(docs.to_print_html(title, blocks, "浏览器打印 → 另存为 PDF"));
    w.document.close();
    return;
  }
  triggerDownload(new Blob([docs.to_docx(title, blocks)], { type: EXT_MIME.docx }), `${c.contract_no}.docx`);
}

function csvBlob(data, name) {
  let body = "";
  if (data.length) {
    const cols = Object.keys(data[0]);
    const cell = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    body = cols.join(",") + "\n" + data.map(r => cols.map(c => cell(r[c])).join(",")).join("\n");
  }
  return { blob: new Blob(["\ufeff" + body], { type: "text/csv;charset=utf-8" }), filename: `${name}_${db.today_str()}.csv` };
}

/** 导出台账 CSV（对应 GET /exports/ledger）。 */
export function exportLedger(target = "contract") {
  let data;
  if (target === "contract") {
    data = db.rows("SELECT c.contract_no AS 合同编号, c.name AS 合同名称, u.name AS 客户,"
      + " c.contract_type AS 类型, c.amount AS 金额, c.amount_type AS 金额口径,"
      + " c.status AS 状态, c.service_start_date AS 服务开始, c.service_end_date AS 服务结束,"
      + " c.sign_date AS 签署日期, o.name AS 负责人"
      + " FROM contract c JOIN customer u ON u.id=c.customer_id"
      + " LEFT JOIN operator o ON o.id=c.owner_id WHERE c.is_deleted=0 ORDER BY c.created_at DESC");
  } else if (target === "quotation") {
    data = db.rows("SELECT q.quotation_no AS 报价单编号, u.name AS 客户, q.amount AS 金额,"
      + " q.status AS 状态, q.valid_until AS 有效期, o.name AS 负责人"
      + " FROM quotation q JOIN customer u ON u.id=q.customer_id"
      + " LEFT JOIN operator o ON o.id=q.owner_id WHERE q.is_deleted=0 ORDER BY q.created_at DESC");
  } else {
    data = db.rows("SELECT c.contract_no AS 合同编号, u.name AS 客户, p.received_date AS 到账日期,"
      + " p.amount AS 金额, p.serial_no AS 流水号 FROM payment p"
      + " JOIN contract c ON c.id=p.contract_id JOIN customer u ON u.id=c.customer_id"
      + " WHERE p.is_deleted=0 ORDER BY p.received_date DESC");
  }
  const { blob, filename } = csvBlob(data, `${target}_ledger`);
  triggerDownload(blob, filename);
}

/** 导出全量备份 JSON（对应 GET /exports/backup）。 */
export function exportBackup() {
  const tables = ["operator", "app_setting", "customer", "quotation", "quotation_version", "quotation_item",
    "contract_template", "contract_template_version", "contract", "contract_item",
    "contract_payment_plan", "contract_version", "contract_attachment", "delivery", "acceptance",
    "invoice", "payment", "reminder", "status_log", "operation_log"];
  const dump = {};
  for (const t of tables) { try { dump[t] = db.rows(`SELECT * FROM ${t}`); } catch { dump[t] = []; } }
  dump._meta = { exported_at: db.now_iso(), product: "业务通", version: "1.0", note: "仅导出未删除数据以外的全量数据" };
  triggerDownload(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" }),
    `business_flow_backup_${db.today_str()}.json`);
}
