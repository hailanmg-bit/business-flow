// app.js — 网页版控制器：初始化数据库、渲染看板/详情/助手、连接本地模块。
import * as db from "./db.js";
import * as catalog from "./catalog.js";
import * as seed from "./seed.js";
import * as proc from "./process.js";
import * as ai from "./ai.js";
import * as engine from "./engine.js";
import * as res from "./resolution.js";

const TRANSITIONS = catalog.TRANSITIONS;
const state = { view: "dashboard", context: {}, detail: null };

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function money(s) {
  if (s == null || s === "") return "—";
  try { return "¥" + (db.to_cents(s) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  catch { return String(s); }
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

// ---------------- 初始化 ----------------
async function init() {
  try { await db.initDatabase(); }
  catch (e) { toast("数据库初始化失败：" + (e.message || e)); return; }
  if (!db.isSeeded()) { try { await seed.seedDatabase(); } catch (e) { toast("初始化演示数据失败：" + (e.message || e)); } }
  renderOpTag();
  renderCustomerFilter();
  renderDashboard();
  initSettings();
  bindEvents();
  if (!ai.getApiKey()) showSetup(); else hideSetup();
}

function renderOpTag() {
  const o = db.one("SELECT name FROM operator WHERE is_deleted=0 ORDER BY created_at LIMIT 1");
  $("#op-tag").textContent = o ? "操作人：" + o.name : "";
}

// ---------------- 看板 ----------------
function renderDashboard() {
  const s = proc.summary();
  $("#summary").innerHTML = `
    <div class="box"><div class="num">${s.active_count}</div><div class="lbl">在办业务</div></div>
    <div class="box"><div class="num">${s.created_this_month}</div><div class="lbl">本月新建合同</div></div>
    <div class="box"><div class="num" style="color:var(--warn)">${money(s.unpaid_total)}</div><div class="lbl">在办未回款</div></div>
    <div class="box"><div class="num" style="color:var(--danger)">${s.stagnant_count}</div><div class="lbl">停滞单</div></div>`;
  renderProcessList();
}

function renderProcessList() {
  const opts = {
    keyword: $("#f-keyword").value.trim(),
    stage: $("#f-stage").value,
    customer_id: $("#f-customer").value,
    stagnant_only: $("#f-stagnant").checked,
  };
  const items = proc.list_processes(opts);
  const box = $("#process-list");
  if (!items.length) { box.innerHTML = `<div class="empty">没有符合条件的业务。试试调整筛选，或在「助手」里用一句话录入或查询。</div>`; return; }
  box.innerHTML = items.map((p) => {
    const kind = p.contract_id ? "合同" : "报价";
    const no = p.contract_no || (p.quotation_id ? "" : "");
    const name = p.contract_name || "";
    const amt = p.amount && p.amount !== "0.00" ? money(p.amount) : (p.contract_id ? "不适用" : "");
    const stg = p.current_stage;
    const stagTag = p.is_stagnant ? `<span class="tag bad">停滞 ${p.stage_days}天</span>` : `<span class="tag stg">${stg}</span>`;
    const next = p.next_actions && p.next_actions.length ? `<span class="tag">建议：${p.next_actions[0]}</span>` : "";
    return `<div class="p-row" data-type="${p.contract_id ? "contract" : "quotation"}" data-id="${p.contract_id || p.quotation_id}">
      <div><div class="cust">${esc(p.customer_name)}</div><div class="sub">${kind} ${esc(no)} ${esc(name)}</div></div>
      <div>${amt ? esc(amt) : '<span class="muted">—</span>'}</div>
      <div>${stagTag}</div>
      <div>${next}<div class="days">停留 ${p.stage_days} 天</div></div>
      <div><button class="btn sm" data-ask="${p.contract_id || p.quotation_id}">问 AI</button></div>
    </div>`;
  }).join("");
}

function renderCustomerFilter() {
  const cs = db.rows("SELECT id, name FROM customer WHERE is_deleted=0 ORDER BY name");
  $("#f-customer").innerHTML = `<option value="">全部客户</option>` + cs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
}

// ---------------- 详情 ----------------
function navigateEntity(type, id) {
  if (!id) return;
  state.detail = { type, id };
  if (type === "customer") state.context = { customer_id: id };
  else if (type === "contract") { const c = db.one("SELECT customer_id FROM contract WHERE id=?", [id]); state.context = { contract_id: id, customer_id: c ? c.customer_id : null }; }
  else if (type === "quotation") { const q = db.one("SELECT customer_id FROM quotation WHERE id=?", [id]); state.context = { quotation_id: id, customer_id: q ? q.customer_id : null }; }
  renderDetail(type, id);
  switchView("detail");
}

let _detailTab = "info";
function renderDetail(type, id) {
  const box = $("#detail-content");
  if (type === "contract") box.innerHTML = renderContract(id);
  else if (type === "customer") box.innerHTML = renderCustomer(id);
  else if (type === "quotation") box.innerHTML = renderQuotation(id);
  else { box.innerHTML = `<div class="empty">未知对象类型</div>`; return; }
  bindDetailEvents();
  // 默认展示第一个 tab
  const first = box.querySelector(".tab"); if (first) first.classList.add("active");
  renderDetailTab(type, id);
}

function renderContract(id) {
  const c = db.one("SELECT c.*, u.name AS customer_name FROM contract c JOIN customer u ON u.id=c.customer_id WHERE c.id=?", [id]);
  if (!c) return `<div class="empty">合同不存在</div>`;
  const amt = db.amount_summary(id);
  const nexts = TRANSITIONS.CONTRACT[c.status] || [];
  const archived = c.is_archived ? `<span class="tag">已归档</span>` : "";
  const advBtns = nexts.map((s) => `<button class="btn sm" data-advance="${esc(s)}">推进到 ${esc(s)}</button>`).join("");
  const archiveBtn = c.is_archived
    ? `<button class="btn sm" data-act="unarchive">取消归档</button>`
    : `<button class="btn sm" data-act="archive">归档</button>`;
  return `
  <div class="detail-head">
    <h2>${esc(c.name)} <span class="tag">${esc(c.contract_no)}</span> <span class="tag stg">${esc(c.status)}</span> ${archived}</h2>
    <div class="detail-meta">
      <span>客户：<b>${esc(c.customer_name)}</b></span>
      <span>金额：${amt.contract_amount ? money(amt.contract_amount) + "（" + esc(c.amount_type) + "）" : "不适用"}</span>
      <span>已回款：${amt.paid_amount ? money(amt.paid_amount) : "—"}</span>
      <span>未回款：${amt.unpaid_amount ? money(amt.unpaid_amount) : "—"}</span>
      <span>服务期：${esc(c.service_start_date)} ~ ${esc(c.service_end_date)}</span>
      ${c.sign_date ? `<span>签署：${esc(c.sign_date)}</span>` : ""}
    </div>
    <div class="detail-actions">
      ${advBtns}
      <button class="btn sm" data-act="clause">问条款</button>
      ${archiveBtn}
      <button class="btn sm" data-act="ask">在此上下文问 AI</button>
    </div>
  </div>
  <div class="tabs">
    <button class="tab" data-tab="info">基本信息</button>
    <button class="tab" data-tab="fulfil">履约记录</button>
    <button class="tab" data-tab="plan">付款计划</button>
    <button class="tab" data-tab="timeline">时间线</button>
    <button class="tab" data-tab="body">合同正文</button>
  </div>
  <div id="detail-tab"></div>`;
}

function renderDetailTab(type, id) {
  const tab = _detailTab;
  const box = $("#detail-tab");
  if (type === "contract") {
    if (tab === "info") box.innerHTML = contractInfo(id);
    else if (tab === "fulfil") box.innerHTML = contractFulfil(id);
    else if (tab === "plan") box.innerHTML = contractPlan(id);
    else if (tab === "timeline") box.innerHTML = contractTimeline(id);
    else if (tab === "body") box.innerHTML = contractBody(id);
  } else if (type === "customer") {
    if (tab === "contracts") box.innerHTML = customerContracts(id);
    else if (tab === "quotations") box.innerHTML = customerQuotations(id);
  } else if (type === "quotation") {
    if (tab === "info") box.innerHTML = quotationInfo(id);
    else if (tab === "body") box.innerHTML = quotationItems(id);
  }
}

function contractInfo(id) {
  const c = db.one("SELECT * FROM contract WHERE id=?", [id]);
  const items = db.rows("SELECT name, spec, quantity, unit_price, amount FROM contract_item WHERE contract_id=? AND is_deleted=0 ORDER BY sort_no", [id]);
  const itbl = items.length ? `<div class="section-title">合同标的</div><table class="tbl"><tr><th>名称</th><th>规格</th><th>数量</th><th>单价</th><th>金额</th></tr>${items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.spec || "—")}</td><td>${esc(i.quantity)}</td><td>${money(i.unit_price)}</td><td>${money(i.amount)}</td></tr>`).join("")}</table>` : "";
  return `<div class="kv">
    <div class="k">合同类型</div><div>${esc(c.contract_type)}</div>
    <div class="k">金额口径</div><div>${esc(c.amount_type)}</div>
    <div class="k">约定交付</div><div>${esc(c.planned_delivery_date || "—")}</div>
    <div class="k">自动续约</div><div>${c.auto_renewal ? "是" : "否"}</div>
    <div class="k">付款条件</div><div>${esc(c.payment_terms || "—")}</div>
    <div class="k">备注</div><div>${esc(c.remark || "—")}</div>
  </div>${itbl}`;
}

function contractFulfil(id) {
  const mk = (rows, cols) => rows.length ? `<table class="tbl"><tr>${cols.map((c) => `<th>${c.h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${c.f(r)}</td>`).join("")}</tr>`).join("")}</table>` : `<div class="muted">暂无记录</div>`;
  const d = db.rows("SELECT * FROM delivery WHERE contract_id=? AND is_deleted=0 ORDER BY ship_date DESC", [id]);
  const a = db.rows("SELECT * FROM acceptance WHERE contract_id=? AND is_deleted=0 ORDER BY accept_date DESC", [id]);
  const inv = db.rows("SELECT * FROM invoice WHERE contract_id=? AND is_deleted=0 ORDER BY invoice_date DESC", [id]);
  const p = db.rows("SELECT * FROM payment WHERE contract_id=? AND is_deleted=0 ORDER BY received_date DESC", [id]);
  return `
    <div class="section-title">交付记录</div>${mk(d, [{ h: "发货日", f: (r) => esc(r.ship_date) }, { h: "内容", f: (r) => esc(r.content) }, { h: "签收", f: (r) => esc(r.receipt_status) }, { h: "物流单号", f: (r) => esc(r.logistics_no || "—") }])}
    <div class="section-title">验收记录</div>${mk(a, [{ h: "验收日", f: (r) => esc(r.accept_date) }, { h: "结果", f: (r) => esc(r.result) }, { h: "备注", f: (r) => esc(r.remark || "—") }])}
    <div class="section-title">开票记录</div>${mk(inv, [{ h: "开票日", f: (r) => esc(r.invoice_date) }, { h: "发票号", f: (r) => esc(r.invoice_no) }, { h: "金额", f: (r) => money(r.amount) }, { h: "签收", f: (r) => esc(r.receipt_status) }])}
    <div class="section-title">回款记录</div>${mk(p, [{ h: "到账日", f: (r) => esc(r.received_date) }, { h: "金额", f: (r) => money(r.amount) }, { h: "流水号", f: (r) => esc(r.serial_no || "—") }])}`;
}

function contractPlan(id) {
  const plans = db.allocate_payments(id).plans;
  if (!plans.length) return `<div class="muted">暂无付款期次。可在「助手」里说「给这份合同加第 1 期 36 万 约定 5 月 1 日回款」。</div>`;
  return `<table class="tbl"><tr><th>期次</th><th>约定金额</th><th>约定回款日</th><th>已核销</th><th>状态</th></tr>${plans.map((p) => `<tr><td>第 ${p.seq_no} 期</td><td>${money(p.plan_amount)}</td><td>${esc(p.due_date)}</td><td>${money(p.allocated_amount)}</td><td>${esc(p.status)}</td></tr>`).join("")}</table>`;
}

function contractTimeline(id) {
  const evs = proc.timeline(id);
  if (!evs.length) return `<div class="muted">暂无时间线</div>`;
  return `<div class="timeline">${evs.map((e) => `<div class="tl-item"><div class="tl-title">${esc(e.title)}</div><div class="tl-summary">${esc(e.summary || "")}</div><div class="tl-when">${esc((e.occurred_at || "").replace("T", " "))}</div></div>`).join("")}</div>`;
}

function contractBody(id) {
  const v = db.one("SELECT * FROM contract_version WHERE contract_id=? ORDER BY created_at DESC LIMIT 1", [id]);
  if (!v) return `<div class="muted">暂无合同正文</div>`;
  return `<div class="section-title">当前版本 ${esc(v.version_no)}</div><div class="contract-body">${v.content || "<i>空</i>"}</div>`;
}

function renderCustomer(id) {
  const c = db.one("SELECT * FROM customer WHERE id=?", [id]);
  if (!c) return `<div class="empty">客户不存在</div>`;
  return `
  <div class="detail-head">
    <h2>${esc(c.name)}</h2>
    <div class="detail-meta">
      <span>信用代码：${esc(c.credit_code || "—")}</span>
      <span>联系人：${esc(c.contact_name || "—")}</span>
      <span>电话：${esc(c.contact_phone || "—")}</span>
      <span>地址：${esc(c.address || "—")}</span>
    </div>
    <div class="detail-actions"><button class="btn sm" data-act="ask">问 AI（这家客户）</button></div>
  </div>
  <div class="tabs">
    <button class="tab active" data-tab="contracts">合同（${db.scalar("SELECT COUNT(*) FROM contract WHERE customer_id=? AND is_deleted=0", [id])}）</button>
    <button class="tab" data-tab="quotations">报价单（${db.scalar("SELECT COUNT(*) FROM quotation WHERE customer_id=? AND is_deleted=0", [id])}）</button>
  </div>
  <div id="detail-tab">${customerContracts(id)}</div>`;
}

function customerContracts(id) {
  const cs = db.rows("SELECT id, contract_no, name, status, amount, amount_type FROM contract WHERE customer_id=? AND is_deleted=0 ORDER BY created_at DESC", [id]);
  return cs.length ? `<table class="tbl"><tr><th>编号</th><th>名称</th><th>状态</th><th>金额</th></tr>${cs.map((c) => `<tr data-row="contract" data-id="${c.id}" style="cursor:pointer"><td>${esc(c.contract_no)}</td><td>${esc(c.name)}</td><td>${esc(c.status)}</td><td>${c.amount_type === "不适用" ? "不适用" : money(c.amount)}</td></tr>`).join("")}</table>` : `<div class="muted">暂无合同</div>`;
}
function customerQuotations(id) {
  const qs = db.rows("SELECT id, quotation_no, status, amount FROM quotation WHERE customer_id=? AND is_deleted=0 ORDER BY created_at DESC", [id]);
  return qs.length ? `<table class="tbl"><tr><th>编号</th><th>状态</th><th>金额</th></tr>${qs.map((q) => `<tr data-row="quotation" data-id="${q.id}" style="cursor:pointer"><td>${esc(q.quotation_no)}</td><td>${esc(q.status)}</td><td>${money(q.amount)}</td></tr>`).join("")}</table>` : `<div class="muted">暂无报价单</div>`;
}

function renderQuotation(id) {
  const q = db.one("SELECT q.*, u.name AS customer_name FROM quotation q JOIN customer u ON u.id=q.customer_id WHERE q.id=?", [id]);
  if (!q) return `<div class="empty">报价单不存在</div>`;
  const nexts = TRANSITIONS.QUOTATION[q.status] || [];
  const advBtns = nexts.map((s) => `<button class="btn sm" data-advance="${esc(s)}">推进到 ${esc(s)}</button>`).join("");
  return `
  <div class="detail-head">
    <h2>${esc(q.quotation_no)} <span class="tag stg">${esc(q.status)}</span></h2>
    <div class="detail-meta">
      <span>客户：<b>${esc(q.customer_name)}</b></span>
      <span>金额：${money(q.amount)}</span>
      <span>有效期至：${esc(q.valid_until)}</span>
      <span>付款条件：${esc(q.payment_terms || "—")}</span>
    </div>
    <div class="detail-actions">
      ${advBtns}
      <button class="btn sm" data-act="convert">报价转合同</button>
      <button class="btn sm" data-act="ask">问 AI</button>
    </div>
  </div>
  <div class="tabs"><button class="tab active" data-tab="info">基本信息</button><button class="tab" data-tab="body">报价明细</button></div>
  <div id="detail-tab">${quotationInfo(id)}</div>`;
}
function quotationInfo(id) { const q = db.one("SELECT * FROM quotation WHERE id=?", [id]); return `<div class="kv"><div class="k">状态</div><div>${esc(q.status)}</div><div class="k">金额</div><div>${money(q.amount)}</div><div class="k">有效期至</div><div>${esc(q.valid_until)}</div><div class="k">付款条件</div><div>${esc(q.payment_terms || "—")}</div><div class="k">备注</div><div>${esc(q.remark || "—")}</div></div>`; }
function quotationItems(id) {
  const items = db.rows("SELECT name, spec, quantity, unit_price, amount FROM quotation_item WHERE quotation_id=? AND is_deleted=0 ORDER BY sort_no", [id]);
  return items.length ? `<table class="tbl"><tr><th>名称</th><th>规格</th><th>数量</th><th>单价</th><th>金额</th></tr>${items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.spec || "—")}</td><td>${esc(i.quantity)}</td><td>${money(i.unit_price)}</td><td>${money(i.amount)}</td></tr>`).join("")}</table>` : `<div class="muted">暂无明细</div>`;
}

function bindDetailEvents() {
  const box = $("#detail-content");
  box.querySelectorAll(".tab").forEach((t) => t.onclick = () => { box.querySelectorAll(".tab").forEach((x) => x.classList.remove("active")); t.classList.add("active"); _detailTab = t.dataset.tab; renderDetailTab(state.detail.type, state.detail.id); });
  box.querySelectorAll("[data-row]").forEach((r) => r.onclick = () => navigateEntity(r.dataset.row, r.dataset.id));
  box.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => detailAct(b.dataset.act, state.detail));
  box.querySelectorAll("[data-advance]").forEach((b) => b.onclick = () => { ensureContext(state.detail); runAssistant(`推进到 ${b.dataset.advance}`); });
}

function ensureContext(d) {
  if (d.type === "contract") { const c = db.one("SELECT customer_id FROM contract WHERE id=?", [d.id]); state.context = { contract_id: d.id, customer_id: c ? c.customer_id : null }; }
  else if (d.type === "quotation") { const q = db.one("SELECT customer_id FROM quotation WHERE id=?", [d.id]); state.context = { quotation_id: d.id, customer_id: q ? q.customer_id : null }; }
  else if (d.type === "customer") state.context = { customer_id: d.id };
}

function detailAct(act, d) {
  ensureContext(d);
  if (act === "ask") { switchView("assistant"); updateCtxChip(); toast("已带入上下文，直接提问即可"); }
  else if (act === "clause") runAssistant("这份合同的付款条件是什么");
  else if (act === "archive") runAssistant("归档这份合同");
  else if (act === "unarchive") runAssistant("取消归档这份合同");
  else if (act === "convert") runAssistant("把这份报价单转成合同");
}

// ---------------- 助手 ----------------
function switchView(name) {
  state.view = name;
  $$(".view").forEach((v) => v.classList.remove("active"));
  $("#view-" + name).classList.add("active");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "assistant") renderChat();
}

async function runAssistant(text) {
  text = (text || "").trim();
  if (!text) return;
  switchView("assistant");
  $("#chat").appendChild(userBubble(text));
  scrollChat();
  let res;
  try { res = await engine.handle(text, state.context); }
  catch (e) { res = { reply: "出错了：" + (e.message || e), events: [] }; }
  $("#chat").appendChild(botBubble(res));
  scrollChat();
}

function userBubble(text) { const w = document.createElement("div"); w.className = "msg user"; const b = document.createElement("div"); b.className = "bubble"; b.textContent = text; w.appendChild(b); return w; }

function botBubble(res) {
  const w = document.createElement("div"); w.className = "msg bot";
  const b = document.createElement("div"); b.className = "bubble"; b.textContent = res.reply || ""; w.appendChild(b);
  if (res.entities && res.entities.length) {
    const ec = document.createElement("div"); ec.className = "entities";
    for (const e of res.entities) { const btn = document.createElement("button"); btn.className = "ent"; btn.textContent = e.label; btn.onclick = () => navigateEntity(e.type, e.id); ec.appendChild(btn); }
    w.appendChild(ec);
  }
  if (res.events) for (const ev of res.events) { const node = renderEvent(ev); if (node) w.appendChild(node); }
  return w;
}

function renderEvent(ev) {
  const note = (txt) => { const d = document.createElement("div"); d.className = "ev-note"; d.textContent = txt; return d; };
  switch (ev.event) {
    case "confirm_card": return renderConfirmCard(ev);
    case "result": {
      const d = document.createElement("div"); d.className = "card-box";
      d.innerHTML = `<div>${esc(ev.message || "已执行")}</div>`;
      if (ev.undoable) { const acts = document.createElement("div"); acts.className = "acts"; const ub = document.createElement("button"); ub.className = "btn sm"; ub.textContent = "撤销"; ub.dataset.action = "undo"; ub.dataset.log = ev.log_id; acts.appendChild(ub); d.appendChild(acts); }
      return d;
    }
    case "sources": if (ev.definition) return note("口径：" + ev.definition + (ev.rowcount != null ? `（${ev.rowcount} 条）` : "")); return null;
    case "citation": if (ev.excerpt) return note("依据：" + ev.excerpt); return null;
    case "disclaimer": return note(ev.text || "AI 回答仅供参考，请以原文为准。");
    case "clarify": {
      const d = document.createElement("div"); d.className = "card-box";
      d.innerHTML = `<div>${esc(ev.message || "需要补充信息")}</div>`;
      if (ev.candidates && ev.candidates.length) {
        const c = document.createElement("div"); c.className = "cand";
        for (const cd of ev.candidates) { const b = document.createElement("button"); b.textContent = cd.label; b.dataset.action = "cand"; b.dataset.cand = cd.label; c.appendChild(b); }
        d.appendChild(c);
      }
      return d;
    }
    case "rejected": return note("已拒绝：" + (ev.message || (ev.action_type || "")));
    case "non_queryable": return note(ev.field ? `「${ev.field}」暂不支持统计` : "该字段无结构化存储，无法统计");
    case "blocked": return note("安全拦截：" + (ev.reason || ""));
    case "error": return note("查询出错：" + (ev.detail || ""));
    case "degraded": return note(ev.message || "已降级");
    case "refused": return note("已拒绝该类请求（" + (ev.reason || "") + "）");
    case "unknown": return null;
    default: return null;
  }
}

function renderConfirmCard(card) {
  const box = document.createElement("div"); box.className = "card-box";
  const changes = (card.changes || []).map((c) => `<div class="chg"><div class="f">${esc(c.label)}</div><div>${esc(c.from ?? "—")}</div><div class="ar">→</div><div>${esc(c.to ?? "—")}</div></div>`).join("");
  box.innerHTML = `<div class="section-title" style="margin:0 0 6px">确认执行：${esc(card.target ? card.target.label : "")}</div>${changes || ""}${card.impact ? `<div class="impact">${esc(card.impact)}</div>` : ""}<div class="acts"><button class="btn primary sm" data-action="confirm" data-aid="${esc(card.action_id)}">确认执行</button><button class="btn sm" data-action="cancel" data-aid="${esc(card.action_id)}">取消</button></div>`;
  return box;
}

function renderChat() {
  const chat = $("#chat");
  chat.innerHTML = "";
  const hist = engine.getHistory();
  if (!hist.length) {
    chat.innerHTML = `<div class="msg bot"><div class="bubble">你好，我是业务通助手。可以直接用一句话查数据、录记录、推进度、问条款。\n例如：本月签了几份合同？/ 宏远科技今天回款 20 万 / 把这份合同推进到履行中</div></div>`;
    renderSuggest();
    return;
  }
  for (const m of hist) {
    if (m.role === "user") chat.appendChild(userBubble(m.content));
    else { try { const p = JSON.parse(m.payload || "{}"); chat.appendChild(botBubble({ reply: m.content, events: p.events || [], entities: p.entities || [] })); } catch { chat.appendChild(botBubble({ reply: m.content })); } }
  }
  renderSuggest();
}

function renderSuggest() {
  const ex = ["本月签了几份合同", "未回款多少", "哪些单卡住了", "最大客户是哪个", "恒美医疗今天回款 20 万"];
  $("#suggest").innerHTML = ex.map((t) => `<button data-suggest="${esc(t)}">${esc(t)}</button>`).join("");
}

function updateCtxChip() {
  const chip = $("#ctx-chip");
  const c = state.context || {};
  if (c.contract_id || c.customer_id || c.quotation_id) {
    let label = "";
    if (c.contract_id) { const x = db.one("SELECT contract_no, name FROM contract WHERE id=?", [c.contract_id]); label = `合同 ${x ? x.contract_no : ""}`; }
    else if (c.quotation_id) { const x = db.one("SELECT quotation_no FROM quotation WHERE id=?", [c.quotation_id]); label = `报价单 ${x ? x.quotation_no : ""}`; }
    else if (c.customer_id) { const x = db.one("SELECT name FROM customer WHERE id=?", [c.customer_id]); label = `客户 ${x ? x.name : ""}`; }
    chip.innerHTML = `上下文：${esc(label)} <button id="ctx-clear">清除</button>`;
    chip.classList.remove("hidden");
    $("#ctx-clear").onclick = () => { state.context = {}; chip.classList.add("hidden"); };
  } else chip.classList.add("hidden");
}

function scrollChat() { const chat = $("#chat"); chat.scrollTop = chat.scrollHeight; }

// ---------------- 设置 ----------------
function initSettings() {
  $("#set-key").value = "";
  $("#set-model").value = ai.getModel();
  $("#set-ai").checked = !!db.get_setting("ai_enabled", true);
  $("#set-qa").checked = !!db.get_setting("ai_contract_qa_enabled", true);
}
function showSetup() { $("#setup").classList.remove("hidden"); }
function hideSetup() { $("#setup").classList.add("hidden"); }

async function testConn() {
  $("#conn-result").textContent = "测试中…";
  const r = await ai.testConnection();
  $("#conn-result").textContent = r.ok ? "✅ " + r.message : "❌ " + r.message;
}

async function resetData() {
  if (!confirm("确定清空全部业务数据并恢复演示素材？此操作不可撤销。")) return;
  await db.resetDatabase();
  await seed.seedDatabase();
  engine.resetSession();
  renderOpTag(); renderCustomerFilter(); renderDashboard();
  toast("已恢复演示数据");
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $$(".nav-btn").forEach((b) => b.onclick = () => switchView(b.dataset.view));
  $$(".back").forEach((b) => b.onclick = () => switchView(b.dataset.view));
  $("#f-keyword").oninput = renderProcessList;
  $("#f-stage").onchange = renderProcessList;
  $("#f-customer").onchange = renderProcessList;
  $("#f-stagnant").onchange = renderProcessList;
  $("#f-refresh").onclick = () => { renderDashboard(); toast("已刷新"); };

  // 进程列表点击
  $("#process-list").addEventListener("click", (e) => {
    const ask = e.target.closest("[data-ask]");
    if (ask) { const id = ask.dataset.ask; const c = db.one("SELECT customer_id FROM contract WHERE id=?", [id]) || db.one("SELECT customer_id FROM quotation WHERE id=?", [id]); state.context = { contract_id: id, customer_id: c ? c.customer_id : null }; switchView("assistant"); updateCtxChip(); toast("已带入上下文，直接提问即可"); return; }
    const row = e.target.closest(".p-row");
    if (row) navigateEntity(row.dataset.type, row.dataset.id);
  });

  // 助手发送
  $("#chat-send").onclick = () => { const v = $("#chat-input").value; $("#chat-input").value = ""; runAssistant(v); };
  $("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = $("#chat-input").value; $("#chat-input").value = ""; runAssistant(v); } });
  $("#suggest").addEventListener("click", (e) => { const b = e.target.closest("[data-suggest]"); if (b) runAssistant(b.dataset.suggest); });

  // 助手内事件委托
  $("#chat").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-action]"); if (!t) return;
    const act = t.dataset.action;
    if (act === "confirm") {
      const box = t.closest(".card-box"); const r = await engine.confirmAction(t.dataset.aid);
      if (!r.ok) { toast(r.reply); return; }
      if (box) { const acts = box.querySelector(".acts"); if (acts) acts.innerHTML = '<span class="muted">已确认执行</span>'; }
      $("#chat").appendChild(botBubble(r)); scrollChat();
    } else if (act === "cancel") {
      const r = engine.cancelAction(t.dataset.aid); toast(r.reply);
      const box = t.closest(".card-box"); if (box) { const acts = box.querySelector(".acts"); if (acts) acts.innerHTML = '<span class="muted">已取消</span>'; }
    } else if (act === "undo") {
      const r = engine.undo(t.dataset.log); toast(r.reply); if (r.ok) { t.disabled = true; t.textContent = "已撤销"; }
    } else if (act === "cand") {
      runAssistant(t.dataset.cand);
    }
  });

  // 设置
  $("#set-test").onclick = testConn;
  $("#set-key").addEventListener("change", () => { const v = $("#set-key").value.trim(); if (v) ai.setApiKey(v); });
  $("#set-model").addEventListener("change", () => { localStorage.setItem("bizflow_deepseek_model", $("#set-model").value.trim() || "deepseek-chat"); });
  $("#set-ai").onchange = () => db.set_setting("ai_enabled", $("#set-ai").checked);
  $("#set-qa").onchange = () => db.set_setting("ai_contract_qa_enabled", $("#set-qa").checked);
  $("#set-reset").onclick = resetData;

  // 首次引导
  $("#setup-save").onclick = () => {
    const v = $("#setup-key").value.trim();
    if (!v) { $("#setup-err").textContent = "请填入 API Key，或点「跳过」。"; return; }
    ai.setApiKey(v); hideSetup(); toast("Key 已保存，开始使用吧");
  };
  $("#setup-skip").onclick = hideSetup;
}

init();
