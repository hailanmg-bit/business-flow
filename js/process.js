// process.js — 业务进程计算（平移自 process.py）。阶段状态由数据自动推导，不人工维护。
import * as db from "./db.js";

const CENTS = "CAST(ROUND(COALESCE({c},0)*100) AS INTEGER)";

export const _CONTRACT_FACT = `
SELECT
  'CONTRACT' AS process_type, c.id AS process_id, c.customer_id, cu.name AS customer_name,
  c.id AS contract_id, c.contract_no, c.name AS contract_name,
  c.source_quotation_id AS quotation_id, c.owner_id, op.name AS owner_name,
  c.status AS contract_status, c.amount AS contract_amount, c.amount_type,
  c.planned_delivery_date, c.service_end_date, c.sign_date, c.is_archived, c.created_at AS started_at,
  q.status AS quotation_status, q.valid_until AS quotation_valid_until,
  q.amount AS quotation_amount, q.created_at AS quotation_created_at,
  (SELECT COUNT(*) FROM delivery d WHERE d.contract_id=c.id AND d.is_deleted=0) AS delivery_cnt,
  (SELECT COUNT(*) FROM delivery d WHERE d.contract_id=c.id AND d.is_deleted=0 AND d.receipt_status='已签收') AS delivery_signed_cnt,
  (SELECT MAX(CASE WHEN d.receipt_status='异常' THEN 1 ELSE 0 END) FROM delivery d WHERE d.contract_id=c.id AND d.is_deleted=0) AS delivery_abnormal,
  (SELECT MAX(d.receipt_date) FROM delivery d WHERE d.contract_id=c.id AND d.is_deleted=0) AS last_receipt_date,
  (SELECT COUNT(*) FROM acceptance a WHERE a.contract_id=c.id AND a.is_deleted=0) AS acceptance_cnt,
  (SELECT MAX(CASE WHEN a.result='通过' THEN 1 ELSE 0 END) FROM acceptance a WHERE a.contract_id=c.id AND a.is_deleted=0) AS acceptance_passed,
  (SELECT MAX(CASE WHEN a.result='不通过' THEN 1 ELSE 0 END) FROM acceptance a WHERE a.contract_id=c.id AND a.is_deleted=0) AS acceptance_rejected,
  (SELECT MAX(a.accept_date) FROM acceptance a WHERE a.contract_id=c.id AND a.is_deleted=0) AS last_accept_date,
  (SELECT COUNT(*) FROM invoice i WHERE i.contract_id=c.id AND i.is_deleted=0) AS invoice_cnt,
  (SELECT MIN(CASE WHEN i.receipt_status='待签收' THEN 0 ELSE 1 END) FROM invoice i WHERE i.contract_id=c.id AND i.is_deleted=0) AS invoice_all_received,
  (SELECT MAX(i.invoice_date) FROM invoice i WHERE i.contract_id=c.id AND i.is_deleted=0) AS last_invoice_date,
  (SELECT COUNT(*) FROM payment p WHERE p.contract_id=c.id AND p.is_deleted=0) AS payment_cnt,
  (SELECT COALESCE(SUM(${CENTS.replace("{c}", "p.amount")}),0) FROM payment p WHERE p.contract_id=c.id AND p.is_deleted=0) AS paid_cents,
  (SELECT MIN(pp.due_date) FROM contract_payment_plan pp WHERE pp.contract_id=c.id AND pp.is_deleted=0) AS min_due_date,
  (SELECT MIN(pp.due_date) FROM contract_payment_plan pp WHERE pp.contract_id=c.id AND pp.is_deleted=0 AND pp.due_date < date('now','localtime')) AS overdue_due_date
FROM contract c
JOIN customer cu ON cu.id = c.customer_id
LEFT JOIN operator op ON op.id = c.owner_id
LEFT JOIN quotation q ON q.id = c.source_quotation_id
WHERE c.is_deleted = 0
`;

const _QUOTATION_FACT = `
SELECT
  'QUOTATION' AS process_type, q.id AS process_id, q.customer_id, cu.name AS customer_name,
  NULL AS contract_id, NULL AS contract_no, NULL AS contract_name,
  q.id AS quotation_id, q.owner_id, op.name AS owner_name,
  NULL AS contract_status, NULL AS contract_amount, NULL AS amount_type,
  NULL AS planned_delivery_date, NULL AS service_end_date, NULL AS sign_date,
  0 AS is_archived, q.created_at AS started_at,
  q.status AS quotation_status, q.valid_until AS quotation_valid_until,
  q.amount AS quotation_amount, q.created_at AS quotation_created_at,
  0 AS delivery_cnt, 0 AS delivery_signed_cnt, 0 AS delivery_abnormal, NULL AS last_receipt_date,
  0 AS acceptance_cnt, 0 AS acceptance_passed, 0 AS acceptance_rejected, NULL AS last_accept_date,
  0 AS invoice_cnt, 0 AS invoice_all_received, NULL AS last_invoice_date,
  0 AS payment_cnt, 0 AS paid_cents,
  NULL AS min_due_date, NULL AS overdue_due_date
FROM quotation q
JOIN customer cu ON cu.id = q.customer_id
LEFT JOIN operator op ON op.id = q.owner_id
WHERE q.is_deleted = 0
  AND NOT EXISTS (SELECT 1 FROM contract c2 WHERE c2.source_quotation_id = q.id AND c2.is_deleted = 0)
`;

const _FACT_SQL = _CONTRACT_FACT + "\nUNION ALL\n" + _QUOTATION_FACT;

export function _stages(f) {
  if (f.process_type === "QUOTATION") {
    const sq = { "草稿": "进行中", "已发出": "进行中", "已确认": "进行中", "已转合同": "已完成", "已失效": "已完成", "已作废": "异常" }[f.quotation_status] || "进行中";
    return { quotation: sq, contract: "未开始", delivery: "未开始", acceptance: "未开始", invoice: "未开始", payment: "未开始", close: "未开始" };
  }
  const sc = !f.contract_id ? "未开始" : f.contract_status === "已作废" ? "异常" : (["履行中", "已到期", "已终止"].includes(f.contract_status) ? "已完成" : "进行中");
  const sd = f.delivery_cnt === 0 ? "未开始" : f.delivery_abnormal ? "异常" : (f.delivery_signed_cnt === f.delivery_cnt ? "已完成" : "进行中");
  const sa = f.acceptance_cnt === 0 ? "未开始" : f.acceptance_rejected ? "异常" : (f.acceptance_passed ? "已完成" : "进行中");
  const si = f.invoice_cnt === 0 ? "未开始" : (f.invoice_all_received ? "已完成" : "进行中");
  let sp;
  if (f.amount_type === "不适用") sp = "不适用";
  else if (f.paid_cents <= 0) sp = "未开始";
  else if (f.amount_type !== null && f.contract_amount !== null && f.paid_cents >= db.to_cents(f.contract_amount)) sp = "已完成";
  else sp = "进行中";
  const scl = !f.contract_id ? "未开始" : (["已到期", "已终止"].includes(f.contract_status) ? (sp === "已完成" || f.amount_type === "不适用" ? "已完成" : "进行中") : "未开始");
  return { quotation: "已完成", contract: sc, delivery: sd, acceptance: sa, invoice: si, payment: sp, close: scl };
}

const _ORDER = [["quotation", "报价"], ["contract", "签约"], ["delivery", "交付"], ["acceptance", "验收"], ["invoice", "开票"], ["payment", "回款"], ["close", "完结"]];

export function _current_stage(f, st) {
  if (f.process_type === "QUOTATION") return ["已转合同", "已失效", "已作废"].includes(f.quotation_status) ? "已完结" : "报价";
  for (const [key, name] of _ORDER) if (!["已完成", "跳过", "不适用"].includes(st[key])) return name;
  return "已完结";
}

function _stage_started_on(f, st, current) {
  const fb = (f.started_at || "").slice(0, 10);
  if (f.process_type === "QUOTATION") return (f.quotation_created_at || fb).slice(0, 10);
  const m = { "报价": f.quotation_created_at || fb, "签约": fb, "交付": f.sign_date || fb, "验收": f.last_receipt_date || fb,
    "开票": f.last_accept_date || fb, "回款": f.last_invoice_date || fb, "完结": f.service_end_date || fb };
  return (m[current] || fb).slice(0, 10);
}

function _days_since(day) {
  if (!day) return 0;
  const d = new Date(day);
  if (isNaN(d)) return 0;
  return Math.round((new Date() - d) / 86400000);
}

export const NEXT_ACTION = { "报价": "跟进客户反馈", "签约": "确认签署进度", "交付": "安排交付", "验收": "跟进验收", "开票": "安排开票", "回款": "跟进回款", "完结": "评估续签", "已完结": "—" };

function _stagnant(f, stage, days, th, has_overdue) {
  if (stage === "已完结" || days <= 0) return false;
  if (stage === "回款") return has_overdue;
  if (stage === "交付") {
    if (f.planned_delivery_date && f.delivery_cnt === 0 && f.planned_delivery_date < db.today_str()) return true;
    return days > (th.delivery_overdue ? 30 : th.delivery_days || 30);
  }
  const limits = { 签约: th.signing_days || 15, 验收: th.acceptance_days || 30, 开票: th.invoice_days || 30, 报价: 30 };
  return days > (limits[stage] || 30);
}

export function overdue_info(contract_id) {
  const plans = db.allocate_payments(contract_id).plans;
  const od = plans.filter(p => p.status === "逾期");
  return [od.length > 0, od.length ? od[0] : null];
}

export function list_processes(opts = {}) {
  const th = db.get_setting("stagnation_threshold", {}) || {};
  const { stage, owner_id, customer_id, keyword, amount_min, amount_max, stagnant_only, include_closed } = opts;
  const out = [];
  for (const f of db.rows(_FACT_SQL)) {
    const st = _stages(f);
    const cur = _current_stage(f, st);
    const started = _stage_started_on(f, st, cur);
    const days = _days_since(started);
    let has_overdue = false, first_overdue = null;
    if (f.contract_id && cur === "回款") { [has_overdue, first_overdue] = overdue_info(f.contract_id); }
    const amount_cents = db.to_cents(f.contract_amount || f.quotation_amount || 0);
    let unpaid = null;
    if (f.amount_type !== "不适用" && f.contract_id) unpaid = db.fmt_money(amount_cents - f.paid_cents);
    const item = {
      process_type: f.process_type, process_id: f.process_id, customer_id: f.customer_id, customer_name: f.customer_name,
      contract_id: f.contract_id, contract_no: f.contract_no, contract_name: f.contract_name, quotation_id: f.quotation_id,
      owner_id: f.owner_id, owner_name: f.owner_name, amount: db.fmt_money(amount_cents), amount_type: f.amount_type || "合同总额",
      paid_amount: db.fmt_money(f.paid_cents), unpaid_amount: unpaid, is_archived: !!f.is_archived, stages: st,
      current_stage: cur, stage_started_on: started, stage_days: days, is_stagnant: _stagnant(f, cur, days, th, has_overdue),
      next_actions: cur !== "已完结" ? [NEXT_ACTION[cur] || "—"] : [], planned_delivery_date: f.planned_delivery_date,
      service_end_date: f.service_end_date, has_overdue, overdue_plan: first_overdue,
    };
    if (!include_closed && cur === "已完结") continue;
    if (stage && cur !== stage) continue;
    if (owner_id && item.owner_id !== owner_id) continue;
    if (customer_id && item.customer_id !== customer_id) continue;
    if (stagnant_only && !item.is_stagnant) continue;
    if (amount_min && amount_cents < db.to_cents(amount_min)) continue;
    if (amount_max && amount_cents > db.to_cents(amount_max)) continue;
    if (keyword) { const hay = `${item.customer_name}${item.contract_name || ""}${item.contract_no || ""}`; if (!hay.includes(keyword)) continue; }
    out.push(item);
  }
  out.sort((a, b) => b.stage_days - a.stage_days);
  return out;
}

export function refresh_snapshot() {
  const items = list_processes({ include_closed: true });
  db.run("DELETE FROM process_snapshot");
  for (const p of items) {
    db.run("INSERT INTO process_snapshot(process_type,process_id,customer_id,customer_name,contract_id,contract_no,contract_name,quotation_id,owner_id,owner_name,amount,amount_type,paid_amount,unpaid_amount,current_stage,stage_days,is_stagnant,is_archived,planned_delivery_date,service_end_date,refreshed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [p.process_type, p.process_id, p.customer_id, p.customer_name, p.contract_id, p.contract_no, p.contract_name, p.quotation_id, p.owner_id, p.owner_name, p.amount, p.amount_type, p.paid_amount, p.unpaid_amount, p.current_stage, p.stage_days, p.is_stagnant ? 1 : 0, p.is_archived ? 1 : 0, p.planned_delivery_date, p.service_end_date, db.now_iso()]);
  }
  return items.length;
}

export function summary() {
  const allp = list_processes({ include_closed: true });
  const active = allp.filter(p => p.current_stage !== "已完结");
  const month = db.today_str().slice(0, 7);
  const unpaid_cents = active.reduce((s, p) => s + db.to_cents(p.unpaid_amount || 0), 0);
  const created = parseInt(db.scalar("SELECT COUNT(*) FROM contract WHERE is_deleted=0 AND substr(created_at,1,7)=?", [month]) || 0, 10);
  return { active_count: active.length, created_this_month: created, unpaid_total: db.fmt_money(unpaid_cents), stagnant_count: active.filter(p => p.is_stagnant).length };
}

export function timeline(process_id) {
  let f = db.one(`SELECT * FROM (${_CONTRACT_FACT}) t WHERE t.contract_id = ?`, [process_id]);
  if (!f) f = db.one(`SELECT * FROM (${_QUOTATION_FACT}) t WHERE t.process_id = ?`, [process_id]);
  if (!f) return [];
  const ev = [];
  const cid = f.contract_id, qid = f.quotation_id;
  if (qid) {
    const q = db.one("SELECT * FROM quotation WHERE id = ?", [qid]);
    if (q) {
      ev.push({ event_type: "QUOTATION_CREATED", occurred_at: q.created_at.slice(0, 19), title: `创建报价单 ${q.quotation_no}`, summary: `金额 ${q.amount} 元 · 有效期至 ${q.valid_until}`, ref: { type: "quotation", id: qid } });
      for (const v of db.rows("SELECT * FROM quotation_version WHERE quotation_id=? ORDER BY created_at", [qid])) {
        if (v.version_no !== "V1.0") ev.push({ event_type: "VERSION_CREATED", occurred_at: v.created_at.slice(0, 19), title: `报价单创建版本 ${v.version_no}`, summary: v.change_summary || "", ref: { type: "quotation", id: qid } });
      }
    }
  }
  if (cid) {
    const c = db.one("SELECT * FROM contract WHERE id = ?", [cid]);
    if (c) {
      ev.push({ event_type: "CONTRACT_CREATED", occurred_at: c.created_at.slice(0, 19), title: `创建合同 ${c.contract_no}`, summary: `${c.name} · 金额 ${c.amount || "不适用"} 元`, ref: { type: "contract", id: cid } });
      for (const a of db.rows("SELECT * FROM attachment WHERE object_type='CONTRACT' AND object_id=? AND is_deleted=0", [cid])) {
        ev.push({ event_type: "ATTACHMENT_UPLOADED", occurred_at: a.uploaded_at.slice(0, 19), title: `上传附件 ${a.file_name}`, summary: a.doc_kind || "", ref: { type: "attachment", id: a.id } });
      }
    }
    for (const s of db.rows("SELECT * FROM status_log WHERE object_type IN ('CONTRACT','QUOTATION') AND object_id IN (?,?) ORDER BY changed_at", [cid, qid || ""])) {
      const who = s.changed_by ? db.one("SELECT name FROM operator WHERE id = ?", [s.changed_by]) : null;
      ev.push({ event_type: "STATUS_CHANGE", occurred_at: s.changed_at.slice(0, 19), title: `状态推进：${s.from_status || "—"} → ${s.to_status}`, summary: `${who ? who.name + " · " : ""}${s.remark || ""}（${s.source}）`, ref: { type: s.object_type.toLowerCase(), id: s.object_id } });
    }
    for (const [tbl, etype, title] of [["delivery", "DELIVERY", "交付"], ["acceptance", "ACCEPTANCE", "验收"], ["invoice", "INVOICE", "开票"], ["payment", "PAYMENT", "回款"]]) {
      for (const r of db.rows(`SELECT * FROM ${tbl} WHERE contract_id=? AND is_deleted=0`, [cid])) {
        const ts = (r.ship_date || r.accept_date || r.invoice_date || r.received_date || "");
        let desc;
        if (tbl === "delivery") desc = `${r.content} · 签收状态 ${r.receipt_status}`;
        else if (tbl === "acceptance") desc = `验收结果 ${r.result}`;
        else if (tbl === "invoice") desc = `发票 ${r.invoice_no} · ${r.amount} 元`;
        else desc = `到账 ${r.amount} 元${r.serial_no ? " · 流水号 " + r.serial_no : ""}`;
        ev.push({ event_type: etype, occurred_at: ts + "T00:00:00", title: `${title}记录`, summary: desc, ref: { type: tbl, id: r.id } });
      }
    }
  }
  ev.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return ev;
}
