// resolution.js — 实体解析（平移自 resolution.py）。LLM 只给原文，ID 由这里得出，不存在编造 ID。
import * as db from "./db.js";

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
  }
  return d[m][n];
}
function seqRatio(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}

const ANAPHORA = ["这单", "那单", "这个", "那个", "它", "刚才那个", "上面提到的", "这家", "该客户", "该合同", "此合同", "这个客户", "那个客户", "这家客户", "这个合同", "那个合同", "上述合同", "前述合同", "这笔", "那笔", "这份", "那份", "该份", "本合同", "这份合同", "那份合同", "该份合同", "本协议", "上述", "前述"];
const STRIP_WORDS = ["那单", "这单", "的单子", "的单", "那个合同", "这个合同", "的合同", "那个", "这个", "单子", "合同", "客户", "公司", "的", " "].concat(ANAPHORA);

const EXACT = 1.0, AUTO_ADOPT = 0.85;

export function normalize(s) { return (s || "").trim().toLowerCase().replace("（", "(").replace("）", ")").replace("　", "").replace(/\s+/g, ""); }

export function is_anaphora(raw) {
  const n = normalize(raw);
  if (!n) return true;
  let stripped = n;
  for (const w of STRIP_WORDS.slice().sort((a, b) => b.length - a.length)) stripped = stripped.split(normalize(w)).join("");
  return stripped === "";
}

function _sim(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return EXACT;
  if (a.includes(b) || b.includes(a)) { const sh = a.length <= b.length ? a : b, lo = a.length <= b.length ? b : a; return 0.82 + 0.13 * (sh.length / lo.length); }
  return seqRatio(a, b) * 0.92;
}

function prefix_hit(raw, name) {
  // 客户名/合同名前 2-3 字出现在句子里即认为命中（用于"恒美医疗这个合同…"这种非精确指代）
  const r = normalize(raw), n = normalize(name);
  for (const k of [3, 2]) if (n.length >= k && r.includes(n.slice(0, k))) return 0.80;
  return 0.0;
}

function _pack(cands) {
  if (!cands.length) return { status: "zero", candidates: [] };
  cands.sort((a, b) => (b.score - a.score) || (b.recent || "").localeCompare(a.recent || ""));
  const best = cands[0];
  if (cands.length === 1 && best.score >= 0.70) return { status: "unique", id: best.id, label: best.label, score: best.score, candidates: [] };
  if (best.score >= EXACT) return { status: "unique", id: best.id, label: best.label, score: best.score, candidates: [] };
  if (best.score >= AUTO_ADOPT && cands[1].score < AUTO_ADOPT - 0.10) return { status: "unique", id: best.id, label: best.label, score: best.score, candidates: [] };
  return { status: "multi", candidates: cands.slice(0, 5) };
}

export function resolve_customer(raw) {
  if (!raw || is_anaphora(raw)) return { status: "zero", candidates: [], reason: "no_name" };
  const all = db.rows("SELECT id, name, credit_code, contact_name, updated_at FROM customer WHERE is_deleted = 0");
  const cands = [];
  for (const c of all) {
    const score = Math.max(_sim(raw, c.name), _sim(raw, c.credit_code || "") * 0.95, _sim(raw, c.contact_name || "") * 0.8, prefix_hit(raw, c.name));
    if (score >= 0.55) {
      const n = parseInt(db.scalar("SELECT COUNT(*) FROM contract WHERE customer_id = ? AND is_deleted = 0 AND status NOT IN ('已到期','已终止','已作废')", [c.id]) || 0, 10);
      cands.push({ id: c.id, label: c.name, score, hint: n ? `在办 ${n} 单` : "无在办业务", recent: c.updated_at || "" });
    }
  }
  const res = _pack(cands); res.raw = raw; return res;
}

export function resolve_contract(raw, context = {}, stack = []) {
  if (raw) {
    let m = raw.toUpperCase().match(/HT-\d{8}-\d{3}/);
    if (m) { const r = db.one("SELECT id, contract_no, name FROM contract WHERE contract_no = ? AND is_deleted = 0", [m[0]]); if (r) return { status: "unique", id: r.id, label: `${r.contract_no} ${r.name}`, score: 1.0, candidates: [], via: "contract_no" }; }
    m = raw.toUpperCase().match(/BJ-\d{8}-\d{3}/);
    if (m) { const r = db.one("SELECT c.id, c.contract_no, c.name FROM contract c JOIN quotation q ON q.id = c.source_quotation_id WHERE q.quotation_no = ? AND c.is_deleted = 0", [m[0]]); if (r) return { status: "unique", id: r.id, label: `${r.contract_no} ${r.name}`, score: 1.0, candidates: [], via: "quotation_no" }; }
  }
  if (raw) {
    let stripped = raw;
    for (const w of STRIP_WORDS.slice().sort((a, b) => b.length - a.length)) stripped = stripped.split(w).join("");
    stripped = stripped.trim();
    if (stripped) {
      const cu = resolve_customer(stripped);
      if (cu.status === "unique") {
        const open = db.rows("SELECT id, contract_no, name, status FROM contract WHERE customer_id = ? AND is_deleted = 0 AND status NOT IN ('已到期','已终止','已作废') ORDER BY created_at DESC", [cu.id]);
        if (open.length === 1) { const c = open[0]; return { status: "unique", id: c.id, label: `${c.contract_no} ${c.name}`, score: 0.95, candidates: [], via: "customer+open" }; }
        if (open.length > 1) return { status: "multi", via: "customer+multi", candidates: open.slice(0, 5).map(c => ({ id: c.id, label: `${c.contract_no} ${c.name}`, hint: c.status, score: 0.8 })) };
      }
    }
  }
  if (is_anaphora(raw) && context.contract_id) { const r = db.one("SELECT id, contract_no, name FROM contract WHERE id = ? AND is_deleted = 0", [context.contract_id]); if (r) return { status: "unique", id: r.id, label: `${r.contract_no} ${r.name}`, score: 1.0, candidates: [], via: "context" }; }
  if (is_anaphora(raw)) {
    for (const item of stack.slice().reverse()) if (item.type === "contract") { const r = db.one("SELECT id, contract_no, name FROM contract WHERE id = ? AND is_deleted = 0", [item.id]); if (r) return { status: "unique", id: r.id, label: `${r.contract_no} ${r.name}`, score: 0.9, candidates: [], via: "stack" }; }
    return { status: "zero", candidates: [], reason: "anaphora_unresolved" };
  }
  const all = db.rows("SELECT c.id, c.contract_no, c.name, c.status, u.name AS customer_name FROM contract c JOIN customer u ON u.id = c.customer_id WHERE c.is_deleted = 0");
  const cands = [];
  for (const c of all) {
    const score = Math.max(_sim(raw, c.name), _sim(raw, `${c.customer_name}${c.name}`) * 0.98, _sim(raw, `${c.customer_name}那单`) * 0.9, prefix_hit(raw, c.name));
    if (score >= 0.55) cands.push({ id: c.id, label: `${c.contract_no} ${c.name}`, score, hint: c.status, recent: "" });
  }
  const res = _pack(cands);
  if (res.status === "zero" && context.contract_id) { const r = db.one("SELECT id, contract_no, name FROM contract WHERE id = ? AND is_deleted = 0", [context.contract_id]); if (r) return { status: "unique", id: r.id, label: `${r.contract_no} ${r.name}`, score: 0.9, candidates: [], via: "context_fallback" }; }
  res.raw = raw; return res;
}

export function resolve_quotation(raw, context = {}, stack = []) {
  if (raw) { const m = raw.toUpperCase().match(/BJ-\d{8}-\d{3}/); if (m) { const r = db.one("SELECT id, quotation_no FROM quotation WHERE quotation_no = ? AND is_deleted = 0", [m[0]]); if (r) return { status: "unique", id: r.id, label: r.quotation_no, score: 1.0, candidates: [] }; } }
  if (raw) {
    let stripped = raw;
    for (const w of STRIP_WORDS.slice().sort((a, b) => b.length - a.length)) stripped = stripped.split(w).join("");
    stripped = stripped.trim();
    if (stripped) {
      const cu = resolve_customer(stripped);
      if (cu.status === "unique") {
        const open = db.rows("SELECT id, quotation_no, status FROM quotation WHERE customer_id=? AND is_deleted=0 AND status NOT IN ('已转合同','已失效','已作废') ORDER BY created_at DESC", [cu.id]);
        if (open.length === 1) { const q = open[0]; return { status: "unique", id: q.id, label: q.quotation_no, score: 0.95, candidates: [], via: "customer+open" }; }
        if (open.length > 1) return { status: "multi", via: "customer+multi", candidates: open.slice(0, 5).map(q => ({ id: q.id, label: q.quotation_no, hint: q.status, score: 0.8 })) };
        return { status: "zero", candidates: [], reason: "customer_has_no_open_quotation" };
      }
    }
  }
  if (is_anaphora(raw)) { for (const item of stack.slice().reverse()) if (item.type === "quotation") return { status: "unique", id: item.id, label: item.label, score: 0.9, candidates: [], via: "stack" }; return { status: "zero", candidates: [], reason: "anaphora_unresolved" }; }
  const all = db.rows("SELECT q.id, q.quotation_no, q.status, u.name AS customer_name FROM quotation q JOIN customer u ON u.id = q.customer_id WHERE q.is_deleted = 0");
  const cands = [];
  for (const q of all) { const score = Math.max(_sim(raw, q.quotation_no), _sim(raw, `${q.customer_name}的报价`) * 0.9, prefix_hit(raw, q.customer_name)); if (score >= 0.55) cands.push({ id: q.id, label: `${q.quotation_no}（${q.customer_name}）`, score, hint: q.status, recent: "" }); }
  const res = _pack(cands); res.raw = raw; return res;
}

export function resolve_record(raw, contract_id, table) {
  if (!contract_id) return { status: "zero", candidates: [] };
  const rs = db.rows(`SELECT * FROM ${table} WHERE contract_id = ? AND is_deleted = 0 ORDER BY created_at DESC`, [contract_id]);
  if (rs.length === 1) return { status: "unique", id: rs[0].id, label: _record_label(table, rs[0]), score: 1.0, candidates: [] };
  if (!rs.length) return { status: "zero", candidates: [] };
  const cands = rs.map(r => ({ id: r.id, label: _record_label(table, r), score: _sim(raw || "", _record_label(table, r)), hint: "", recent: r.created_at }));
  return _pack(cands);
}

function _record_label(table, r) {
  if (table === "delivery") return `${r.ship_date} 交付 ${r.content}`;
  if (table === "acceptance") return `${r.accept_date} 验收${r.result}`;
  if (table === "invoice") return `${r.invoice_date} 发票 ${r.invoice_no} ${r.amount}`;
  return `${r.received_date} 回款 ${r.amount}`;
}

export function resolve_operator(raw) {
  if (!raw) return { status: "zero", candidates: [] };
  const os = db.rows("SELECT id, name FROM operator WHERE is_deleted = 0");
  const cands = os.map(o => ({ id: o.id, label: o.name, score: _sim(raw, o.name), hint: "", recent: "" })).filter(c => c.score >= 0.55);
  const res = _pack(cands); res.raw = raw; return res;
}

export function resolve_template(raw) {
  if (!raw) return { status: "zero", candidates: [], reason: "no_name" };
  const ts = db.rows("SELECT id, name, status FROM contract_template WHERE is_deleted = 0");
  const cands = ts.map(t => ({ id: t.id, label: t.name, score: _sim(raw, t.name), hint: t.status, recent: "" })).filter(c => c.score >= 0.55);
  const res = _pack(cands); res.raw = raw; return res;
}

export function push_entities(stack, items) {
  const out = stack.slice();
  for (const it of items) out.push({ type: it.type, id: it.id, label: it.label || "", at: it.at || "" });
  return out.slice(-20);
}
