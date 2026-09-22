/* 业务通 前端（纯前端网页版）
 *
 * 界面与交互与本地体验版（app/web）逐行一致；
 * 唯一差异是数据源：后端 FastAPI 被替换为浏览器内的本地 API 层（js/api.js），
 * 数据库由 sql.js 在浏览器里跑真实 SQLite，持久化到 IndexedDB。
 */
import * as db from './js/db.js';
import * as seed from './js/seed.js';
import * as AI from './js/ai.js';
import {
  apiLocal, importScans as importScansApi,
  downloadAttachment, exportQuotationDocument, exportContractDocument,
  exportLedger, exportBackup,
} from './js/api.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = (v) => (v === null || v === undefined || v === '') ? '—' : '¥' + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2 });

const S = { view: 'process', op: null, operators: [], settings: {}, reminders: 0, conv: null, context: {}, board: true, tab: 'overview', detailId: null, filters: {} };

/* 与后端同名同形的调用入口：所有接口都走浏览器本地实现 */
async function api(path, opt = {}) {
  try {
    return await apiLocal(path, opt);
  } catch (e) {
    // 与 FastAPI 版保持一致的错误形状：message / code / field
    throw e instanceof Error ? e : new Error(String(e));
  }
}
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg;
  t.style.background = bad ? '#A32D2D' : '#2C2C2A'; t.classList.add('on');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2200);
}

/* 兜底：内联 onclick 调用的都是 async 函数，一旦抛错就成了"点了没反应"。
   这里统一接住未处理的 Promise 异常，至少让用户知道失败了、失败在哪。 */
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const msg = (r && r.message) ? r.message : String(r || '未知错误');
  toast('操作失败：' + msg, true);
  console.error('[未处理异常]', r);
});

/* ---------- 状态样式 ---------- */
const STATUS_TAG = {
  '草稿': 't-gray', '已发出': 't-blue', '已确认': 't-teal', '已转合同': 't-teal', '已失效': 't-gray', '已作废': 't-gray',
  '待签署': 't-amber', '履行中': 't-teal', '已到期': 't-gray', '已终止': 't-red',
  '通过': 't-teal', '不通过': 't-red', '待验收': 't-amber', '待签收': 't-amber', '已签收': 't-teal', '异常': 't-red',
  '启用': 't-teal', '停用': 't-gray',
};
const tag = (t) => t ? `<span class="tag ${STATUS_TAG[t] || 't-gray'}">${esc(t)}</span>` : '';
const STAGE_CLS = { '已完成': 'done', '进行中': 'now', '未开始': '', '异常': 'bad', '已跳过': 'skip', '不适用': 'skip' };

/* ---------- 启动 ---------- */
(async function boot() {
  // ① 装载浏览器内数据库（sql.js）与演示素材
  try {
    await db.initDatabase();
    if (!db.isSeeded()) {
      setBootMsg('正在生成演示素材（客户 / 报价 / 合同 / 履约 / 提醒）…');
      seed.seedDatabase();
      db.persist();
    }
  } catch (e) {
    setBootMsg('初始化失败：' + (e && e.message ? e.message : e));
    console.error('[boot]', e);
    return;
  }
  $('#bootMask').style.display = 'none';

  // ② 网页版没有后端，模型 Key 由使用者自己填
  if (AI.getApiKey()) hideKeyBox(); else showKeyBox();
  bindKeyBox();

  await loadOperators();
  await loadSettings();
  bindNav();
  $$('#nav a').forEach((a) => a.onclick = () => go(a.dataset.v));
  $('#scrim').onclick = closeDrawer;
  go('process');
  refreshBadges();
})();

function setBootMsg(t) { const el = $('#bootMsg'); if (el) el.textContent = t; }

/* ---------- 首次进入的 Key 引导 ---------- */
function showKeyBox() {
  const k = $('#keyInput');
  if (k) k.value = AI.getApiKey() || '';
  const m = $('#keyModel');
  if (m) m.value = AI.getModel();
  $('#keyScrim').style.display = 'block';
  $('#keyBox').style.display = 'block';
}
function hideKeyBox() {
  $('#keyScrim').style.display = 'none';
  $('#keyBox').style.display = 'none';
}
function bindKeyBox() {
  $('#keySave').onclick = () => {
    const k = $('#keyInput').value.trim();
    if (!k) { $('#keyErr').textContent = '请填入 Key，或点「先跳过」。'; return; }
    AI.setApiKey(k);
    const m = $('#keyModel').value.trim();
    if (m) localStorage.setItem('bizflow_deepseek_model', m);
    hideKeyBox(); toast('已保存，AI 助手可用');
    if (S.view === 'settings') render();
  };
  $('#keySkip').onclick = () => { hideKeyBox(); toast('已跳过，可随时在「设置」页填写'); };
  $('#keyScrim').onclick = () => hideKeyBox();
}

async function loadOperators() {
  S.operators = await api('/operators');
  const sel = $('#opSwitch');
  sel.innerHTML = S.operators.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  const st = await api('/settings');
  S.op = st.current_operator_id || (S.operators[0] || {}).id;
  sel.value = S.op;
  sel.onchange = async () => {
    await api('/settings/current-operator', { method: 'POST', body: { operator_id: sel.value } });
    S.op = sel.value; toast('已切换操作人'); render();
  };
}
async function loadSettings() { S.settings = await api('/settings'); }

async function refreshBadges() {
  try {
    const r = await api('/reminders?is_read=false');
    S.reminders = r.list.length;
    const el = $('#navRemind');
    el.style.display = S.reminders ? '' : 'none'; el.textContent = S.reminders;
  } catch (e) { }
}

function bindNav() {
  $('#nav a[data-v="' + S.view + '"]')?.classList.add('on');
}
function go(v) {
  S.view = v; S.detailId = null;
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.v === v));
  render();
}

const TITLES = { process: ['业务进程', '每一单现在走到哪、卡了多久'], customers: ['客户', '客户档案与关联业务'], quotations: ['报价', '报价单与转化'], contracts: ['合同', '合同台账'], templates: ['模板库', '报价单模板与合同模板，用于对外出文档'], reminders: ['提醒', '到期、超期与停滞'], assistant: ['智能助手', '查数据、录记录、推进度、问条款'], settings: ['设置', '操作人、阈值、导出'] };

async function render() {
  const [t, sub] = TITLES[S.view] || ['', ''];
  $('#pageTitle').textContent = t; $('#pageSub').textContent = sub; $('#headExtra').innerHTML = '';
  const v = $('#view'); v.innerHTML = '<div class="empty"><span class="spin"></span> 加载中…</div>';
  try {
    if (S.view === 'process') return await viewProcess(v);
    if (S.view === 'customers') return await viewCustomers(v);
    if (S.view === 'quotations') return await viewQuotations(v);
    if (S.view === 'contracts') return await viewContracts(v);
    if (S.view === 'templates') return await viewTemplates(v);
    if (S.view === 'reminders') return await viewReminders(v);
    if (S.view === 'assistant') return await viewAssistant(v);
    if (S.view === 'settings') return await viewSettings(v);
  } catch (e) { v.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
}

/* ================= 业务进程 ================= */
async function viewProcess(v) {
  const q = new URLSearchParams({ include_closed: S.filters.closed ? 'true' : 'false' });
  if (S.filters.stage) q.set('stage', S.filters.stage);
  if (S.filters.stagnant) q.set('stagnant_only', 'true');
  if (S.filters.kw) q.set('keyword', S.filters.kw);
  const d = await api('/processes?' + q);
  const sm = d.summary;
  const stages = ['报价', '签约', '交付', '验收', '开票', '回款', '完结'];
  const boardHtml = S.board ? `<div class="board">${stages.map((s) => {
    const list = d.board[s] || [];
    return `<div class="col"><h4>${s}<span>${list.length}</span></h4><hr/>
      ${list.map((p) => pcard(p)).join('') || '<div class="muted" style="padding:6px 4px">—</div>'}</div>`;
  }).join('')}</div>` : '';

  const listHtml = `<table><thead><tr>
      <th>客户</th><th>合同 / 报价</th><th class="num">金额</th><th class="num">已回款</th>
      <th class="num">未回款</th><th>当前阶段</th><th class="num">停留</th><th>负责人</th></tr></thead><tbody>
    ${d.list.map((p) => `<tr class="clickable" onclick="openProcess('${p.process_id}')">
      <td><b>${esc(p.customer_name)}</b></td>
      <td>${p.contract_no ? `<span class="mono">${esc(p.contract_no)}</span><div class="muted">${esc(p.contract_name || '')}</div>` : `<span class="mono">${esc(p.quotation_id ? '报价中' : '')}</span>`}</td>
      <td class="num">${yuan(p.amount)}</td><td class="num">${yuan(p.paid_amount)}</td>
      <td class="num">${p.unpaid_amount === null ? '不适用' : yuan(p.unpaid_amount)}</td>
      <td>${tag(p.current_stage)} ${p.is_stagnant ? '<span class="tag t-red">停滞</span>' : ''}</td>
      <td class="num">${p.stage_days} 天</td><td>${esc(p.owner_name || '—')}</td></tr>`).join('')
    || '<tr><td colspan="8" class="empty">暂无在办业务</td></tr>'}</tbody></table>`;

  v.innerHTML = `
    <div class="grid4">
      <div class="kpi"><div class="l">在办业务</div><div class="v">${sm.active_count}</div></div>
      <div class="kpi"><div class="l">本月新增合同</div><div class="v">${sm.created_this_month}</div></div>
      <div class="kpi"><div class="l">待回款合计</div><div class="v sm">${yuan(sm.unpaid_total)}</div></div>
      <div class="kpi"><div class="l">停滞业务</div><div class="v" style="${sm.stagnant_count ? 'color:#A32D2D' : ''}">${sm.stagnant_count}</div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="row wrap">
        <input id="fKw" placeholder="搜索客户 / 合同 / 编号" style="max-width:240px" value="${esc(S.filters.kw || '')}"/>
        <select id="fStage" style="max-width:130px">
          <option value="">全部阶段</option>${stages.map((s) => `<option ${S.filters.stage === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <label class="row" style="gap:5px"><input type="checkbox" id="fStag" style="width:auto" ${S.filters.stagnant ? 'checked' : ''}/><span class="muted">只看停滞</span></label>
        <label class="row" style="gap:5px"><input type="checkbox" id="fClosed" style="width:auto" ${S.filters.closed ? 'checked' : ''}/><span class="muted">含已完结</span></label>
        <span class="grow"></span>
        <button onclick="toggleBoard()">${S.board ? '列表视图' : '看板视图'}</button>
      </div>
    </div>
    ${S.board ? '<h2 class="sec">看板</h2>' + boardHtml : ''}
    <h2 class="sec">${S.board ? '全部在办' : '列表'}</h2>
    <div class="card" style="padding:0;overflow:auto">${listHtml}</div>`;

  const apply = () => {
    S.filters.kw = $('#fKw').value.trim(); S.filters.stage = $('#fStage').value;
    S.filters.stagnant = $('#fStag').checked; S.filters.closed = $('#fClosed').checked; render();
  };
  $('#fKw').onkeydown = (e) => { if (e.key === 'Enter') apply(); };
  $('#fStage').onchange = apply; $('#fStag').onchange = apply; $('#fClosed').onchange = apply;
}
function toggleBoard() { S.board = !S.board; render(); }
// 注意：本文件是 ES Module，模块内声明的函数不会自动成为全局。
// 内联 onclick="..." 是在全局作用域里求值的，所以凡是被内联调用的函数都必须显式挂到 window。
window.toggleBoard = toggleBoard;

function pcard(p) {
  const bad = p.is_stagnant;
  return `<div class="pcard" onclick="openProcess('${p.process_id}')">
    <div class="t">${esc(p.customer_name)}</div>
    <div class="n">${esc(p.contract_name || p.contract_no || '报价单')}</div>
    <div class="b"><span class="mono">${yuan(p.amount)}</span>
      <span class="tag ${bad ? 't-red' : 't-gray'}">${bad ? '停滞 ' + p.stage_days + ' 天' : p.stage_days + ' 天'}</span></div>
  </div>`;
}

async function openProcess(pid) {
  const d = await api('/processes/' + pid);
  const p = d.process;
  const order = ['quotation', 'contract', 'delivery', 'acceptance', 'invoice', 'payment', 'close'];
  const names = { quotation: '报价', contract: '签约', delivery: '交付', acceptance: '验收', invoice: '开票', payment: '回款', close: '完结' };
  openDrawer(`${esc(p.customer_name)} · 业务进程`, `
    <div class="card">
      <div class="row"><b style="font-size:15px">${esc(p.contract_name || p.contract_no || '报价中')}</b></div>
      <div class="muted mono" style="margin:4px 0 10px">${esc(p.contract_no || '')}</div>
      <div class="stages">${order.map((k) => `<div class="stage ${STAGE_CLS[p.stages[k]] || ''}">${names[k]}<br/>${esc(p.stages[k] || '')}</div>`).join('')}</div>
      <div class="grid3" style="margin-top:12px">
        <div><div class="muted">金额</div><b>${yuan(p.amount)}</b></div>
        <div><div class="muted">已回款</div><b>${yuan(p.paid_amount)}</b></div>
        <div><div class="muted">未回款</div><b>${p.unpaid_amount === null ? '不适用' : yuan(p.unpaid_amount)}</b></div>
      </div>
      <div class="row" style="margin-top:10px">
        <span>当前阶段：<b>${esc(p.current_stage)}</b></span>
        <span class="muted">已停留 ${p.stage_days} 天</span>
        ${p.is_stagnant ? '<span class="tag t-red">停滞</span>' : ''}
        ${p.next_actions.length ? `<span class="tag t-amber">建议：${esc(p.next_actions[0])}</span>` : ''}
      </div>
      ${p.contract_id ? `<div style="margin-top:12px"><button class="primary" onclick="openContract('${p.contract_id}')">打开合同详情</button></div>` : ''}
    </div>
    <h2 class="sec">完整事件流</h2>
    <div class="card"><div class="tl">${d.timeline.map((e) => `
      <div class="it ${e.event_type === 'STATUS_CHANGE' ? '' : 'g'}">
        <div class="d">${esc((e.occurred_at || '').replace('T', ' ').slice(0, 16))}</div>
        <div class="h">${esc(e.title)}</div>
        <div class="s">${esc(e.summary || '')}</div>
      </div>`).join('') || '<div class="empty">暂无事件</div>'}</div></div>`);
}
window.openProcess = openProcess;

/* ================= 客户 ================= */
async function viewCustomers(v) {
  const d = await api('/customers?page_size=100');
  $('#headExtra').innerHTML = '<button class="primary" onclick="newCustomer()">新建客户</button>';
  v.innerHTML = `<div class="card" style="padding:0;overflow:auto"><table><thead><tr>
      <th>客户名称</th><th>联系人</th><th>电话</th><th class="num">合同</th><th class="num">报价单</th><th>负责人</th></tr></thead><tbody>
    ${d.list.map((c) => `<tr class="clickable" onclick="openCustomer('${c.id}')">
      <td><b>${esc(c.name)}</b><div class="muted mono">${esc(c.credit_code || '')}</div></td>
      <td>${esc(c.contact_name || '—')}</td><td>${esc(c.contact_phone || '—')}</td>
      <td class="num">${c.contract_count}</td><td class="num">${c.quotation_count}</td>
      <td>${esc(c.owner_name || '—')}</td></tr>`).join('')}</tbody></table></div>`;
}
window.viewCustomers = viewCustomers;

function newCustomer() {
  openDrawer('新建客户', `<form id="fCust">
    <div class="grid2"><div class="field"><label class="f">客户名称 *</label><input name="name" required/></div>
    <div class="field"><label class="f">统一社会信用代码</label><input name="credit_code"/></div></div>
    <div class="grid2"><div class="field"><label class="f">联系人</label><input name="contact_name"/></div>
    <div class="field"><label class="f">电话</label><input name="contact_phone"/></div></div>
    <div class="field"><label class="f">地址</label><input name="address"/></div>
    <div class="grid2"><div class="field"><label class="f">开票名称</label><input name="invoice_title"/></div>
    <div class="field"><label class="f">税号</label><input name="invoice_tax_no"/></div></div>
    <div class="grid2"><div class="field"><label class="f">开户行</label><input name="invoice_bank"/></div>
    <div class="field"><label class="f">银行账号</label><input name="invoice_account"/></div></div>
    <div class="field"><label class="f">负责人</label><select name="owner_id">${S.operators.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></div>
    <div class="row" style="margin-top:12px"><button class="primary" type="submit">保存</button></div></form>`);
  $('#fCust').onsubmit = async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    try { await api('/customers', { method: 'POST', body: b }); toast('客户已创建'); closeDrawer(); render(); }
    catch (err) { toast(err.message, true); }
  };
}
window.newCustomer = newCustomer;

async function openCustomer(id) {
  const d = await api('/customers/' + id);
  const c = d.customer;
  openDrawer(esc(c.name), `
    <div class="grid3">
      <div class="kpi"><div class="l">合同总额</div><div class="v sm">${yuan(d.amount.contract_total)}</div></div>
      <div class="kpi"><div class="l">已回款</div><div class="v sm">${yuan(d.amount.paid_total)}</div></div>
      <div class="kpi"><div class="l">未回款</div><div class="v sm" style="color:#A32D2D">${yuan(d.amount.unpaid_total)}</div></div>
    </div>
    <h2 class="sec">基本信息</h2>
    <div class="card">
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><div class="muted">统一社会信用代码</div>${esc(c.credit_code || '—')}</div>
        <div><div class="muted">联系人</div>${esc(c.contact_name || '—')} ${esc(c.contact_phone || '')}</div>
        <div><div class="muted">地址</div>${esc(c.address || '—')}</div>
        <div><div class="muted">负责人</div>${esc(c.owner_name || '—')}</div>
        <div><div class="muted">开票名称</div>${esc(c.invoice_title || '—')}</div>
        <div><div class="muted">税号</div>${esc(c.invoice_tax_no || '—')}</div>
        <div><div class="muted">开户行</div>${esc(c.invoice_bank || '—')}</div>
        <div><div class="muted">银行账号</div>${esc(c.invoice_account || '—')}</div>
      </div>
    </div>
    <h2 class="sec">关联合同（${d.contracts.length}）</h2>
    <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>编号</th><th>名称</th><th class="num">金额</th><th>状态</th></tr></thead><tbody>
      ${d.contracts.map((x) => `<tr class="clickable" onclick="openContract('${x.id}')"><td class="mono">${esc(x.contract_no)}</td>
        <td>${esc(x.name)}</td><td class="num">${yuan(x.amount)}</td><td>${tag(x.status)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">无</td></tr>'}
    </tbody></table></div>
    <h2 class="sec">关联报价单（${d.quotations.length}）</h2>
    <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>编号</th><th class="num">金额</th><th>状态</th><th>有效期</th></tr></thead><tbody>
      ${d.quotations.map((x) => `<tr class="clickable" onclick="openQuotation('${x.id}')"><td class="mono">${esc(x.quotation_no)}</td>
        <td class="num">${yuan(x.amount)}</td><td>${tag(x.status)}</td><td>${esc(x.valid_until)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">无</td></tr>'}
    </tbody></table></div>`);
}
window.openCustomer = openCustomer;

/* ================= 报价 ================= */
async function viewQuotations(v) {
  const d = await api('/quotations?page_size=100');
  $('#headExtra').innerHTML = '<button class="primary" onclick="newQuotation()">新建报价单</button>';
  v.innerHTML = `<div class="card" style="padding:0;overflow:auto"><table><thead><tr>
      <th>编号</th><th>客户</th><th class="num">金额</th><th>状态</th><th>有效期</th><th>负责人</th><th>转为合同</th></tr></thead><tbody>
    ${d.list.map((q) => `<tr class="clickable" onclick="openQuotation('${q.id}')">
      <td class="mono">${esc(q.quotation_no)}</td><td>${esc(q.customer_name)}</td>
      <td class="num">${yuan(q.amount)}</td><td>${tag(q.status)}</td><td>${esc(q.valid_until)}</td>
      <td>${esc(q.owner_name || '—')}</td><td class="mono">${esc(q.converted_contract_no || '—')}</td></tr>`).join('')}
    </tbody></table></div>`;
}
window.viewQuotations = viewQuotations;

function newQuotation() {
  api('/customers?page_size=200').then((cs) => {
    openDrawer('新建报价单', `<form id="fQ">
      <div class="field"><label class="f">客户 *</label><select name="customer_id" required>${cs.list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="grid2"><div class="field"><label class="f">金额 *</label><input name="amount" placeholder="500000.00" required/></div>
      <div class="field"><label class="f">有效期至</label><input type="date" name="valid_until"/></div></div>
      <div class="field"><label class="f">付款条件</label><input name="payment_terms" placeholder="签订后支付 30%，验收后支付 70%"/></div>
      <div class="row"><button class="primary" type="submit">创建</button></div></form>`);
    $('#fQ').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('/quotations', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('已创建 ' + r.quotation_no); closeDrawer(); render(); }
      catch (err) { toast(err.message, true); }
    };
  });
}
window.newQuotation = newQuotation;

async function openQuotation(id) {
  const d = await api('/quotations/' + id);
  const q = d.quotation;
  let tpls = [];
  try { tpls = (await api('/templates?template_type=' + encodeURIComponent('报价单'))).list; } catch (e) { }
  openDrawer(esc(q.quotation_no), `
    <div class="card">
      <div class="row"><b>${esc(q.customer_name)}</b><span class="grow"></span>${tag(q.status)}</div>
      <div class="grid3" style="margin-top:10px">
        <div><div class="muted">金额</div><b>${yuan(q.amount)}</b></div>
        <div><div class="muted">有效期至</div><b>${esc(q.valid_until)}</b></div>
        <div><div class="muted">负责人</div><b>${esc(q.owner_name || '—')}</b></div>
      </div>
      <div style="margin-top:8px"><div class="muted">付款条件</div>${esc(q.payment_terms || '—')}</div>
      ${tpls.length ? `<div class="field" style="margin-top:10px"><label class="f">导出所用模板</label>
        <select id="qTpl">${tpls.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>` : ''}
      <div class="row wrap" style="margin-top:12px">
        <button class="primary" onclick="exportQ('${q.id}','docx')">导出 Word</button>
        <button onclick="exportQ('${q.id}','print')">打印 / 另存 PDF</button>
        ${d.allowed_transitions.map((t) => `<button onclick="advance('quotations','${q.id}','${t}')">推进为「${t}」</button>`).join('')}
        ${q.status !== '已转合同' && !['已作废', '已失效'].includes(q.status) ? `<button class="primary" onclick="convertQ('${q.id}')">转合同</button>` : ''}
      </div>
      <div class="muted" style="margin-top:8px">对外发送时建议用 Word 版（可编辑、可盖章）；需要 PDF 就用「打印 / 另存 PDF」。</div>
      ${d.converted_contract ? `<div class="muted" style="margin-top:8px">已转合同：<a href="#" onclick="openContract('${d.converted_contract.id}');return false">${esc(d.converted_contract.contract_no)}</a></div>` : ''}
    </div>
    <h2 class="sec">明细</h2>
    <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>项目</th><th>规格</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th></tr></thead><tbody>
      ${d.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.spec || '—')}</td><td class="num">${esc(i.quantity)}</td><td class="num">${yuan(i.unit_price)}</td><td class="num">${yuan(i.amount)}</td></tr>`).join('')}
    </tbody></table></div>
    <h2 class="sec">版本</h2>
    <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>版本</th><th class="num">金额</th><th>变更摘要</th><th>创建时间</th></tr></thead><tbody>
      ${d.versions.map((x) => `<tr><td>${esc(x.version_no)}</td><td class="num">${yuan(x.amount)}</td><td>${esc(x.change_summary || '')}</td><td class="muted">${esc((x.created_at || '').slice(0, 10))}</td></tr>`).join('')}
    </tbody></table></div>
    <h2 class="sec">回签件存档（${(d.attachments || []).length}）</h2>
    ${importPanel('QUOTATION', q.id, [])}
    ${attachmentTable(d.attachments || [])}`);
}
function exportQ(id, fmt) {
  const t = $('#qTpl');
  const tid = t && t.value ? t.value : null;
  try { exportQuotationDocument(id, fmt, tid); }
  catch (e) { toast(e.message, true); }
}
window.exportQ = exportQ;
window.openQuotation = openQuotation;

function convertQ(id) {
  openDrawer('报价转合同', `<form id="fCV">
    <div class="field"><label class="f">合同名称</label><input name="name" placeholder="留空自动生成"/></div>
    <div class="grid2"><div class="field"><label class="f">服务开始日期 *</label><input type="date" name="service_start_date" required/></div>
    <div class="field"><label class="f">服务结束日期 *</label><input type="date" name="service_end_date" required/></div></div>
    <div class="field"><label class="f">合同类型</label><select name="contract_type"><option>服务合同</option><option>销售合同</option><option>框架合同</option><option>其他</option></select></div>
    <div class="row"><button class="primary" type="submit">生成合同草稿</button></div></form>`);
  $('#fCV').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api(`/quotations/${id}/convert-to-contract`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('已生成 ' + r.contract_no); openContract(r.contract_id); render(); }
    catch (err) { toast(err.message, true); }
  };
}
window.convertQ = convertQ;

async function advance(obj, id, to, remark) {
  try { await api(`/${obj}/${id}/status-transitions`, { method: 'POST', body: { to_status: to, remark: remark || '' } }); toast('已推进为「' + to + '」'); closeDrawer(); render(); refreshBadges(); }
  catch (e) { toast(e.message, true); }
}
window.advance = advance;

/* ================= 合同 ================= */
async function viewContracts(v) {
  const d = await api('/contracts?page_size=100');
  $('#headExtra').innerHTML = '<button class="primary" onclick="newContract()">新建合同</button>';
  v.innerHTML = `<div class="card" style="padding:0;overflow:auto"><table><thead><tr>
      <th>编号</th><th>名称</th><th>客户</th><th class="num">金额</th><th class="num">已回款</th><th>状态</th><th>服务期</th><th>负责人</th></tr></thead><tbody>
    ${d.list.map((c) => `<tr class="clickable" onclick="openContract('${c.id}')">
      <td class="mono">${esc(c.contract_no)}</td><td>${esc(c.name)}</td><td>${esc(c.customer_name)}</td>
      <td class="num">${c.amount_type === '不适用' ? '不适用' : yuan(c.amount)}</td>
      <td class="num">${yuan(c.amount_summary.paid_amount)}</td>
      <td>${tag(c.status)}${c.is_archived ? ' <span class="tag t-gray">已归档</span>' : ''}</td>
      <td class="muted">${esc(c.service_start_date)} ~ ${esc(c.service_end_date)}</td>
      <td>${esc(c.owner_name || '—')}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">暂无合同</td></tr>'}
    </tbody></table></div>`;
}
window.viewContracts = viewContracts;

function newContract() {
  api('/customers?page_size=200').then((cs) => {
    openDrawer('新建合同', `<form id="fC">
      <div class="field"><label class="f">客户 *</label><select name="customer_id" required>${cs.list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label class="f">合同名称</label><input name="name" placeholder="留空自动生成"/></div>
      <div class="grid2"><div class="field"><label class="f">合同类型</label><select name="contract_type"><option>服务合同</option><option>销售合同</option><option>框架合同</option><option>其他</option></select></div>
      <div class="field"><label class="f">金额口径</label><select name="amount_type"><option>合同总额</option><option>框架上限</option><option>不适用</option></select></div></div>
      <div class="grid2"><div class="field"><label class="f">金额</label><input name="amount" placeholder="500000.00"/></div>
      <div class="field"><label class="f">签署日期</label><input type="date" name="sign_date"/></div></div>
      <div class="grid2"><div class="field"><label class="f">服务开始 *</label><input type="date" name="service_start_date" required/></div>
      <div class="field"><label class="f">服务结束 *</label><input type="date" name="service_end_date" required/></div></div>
      <div class="grid2"><div class="field"><label class="f">约定交付日期</label><input type="date" name="planned_delivery_date"/></div>
      <div class="field"><label class="f">自动续约</label><select name="auto_renewal"><option value="false">否</option><option value="true">是</option></select></div></div>
      <div class="field"><label class="f">付款条件（自由文本）</label><input name="payment_terms"/></div>
      <div class="row"><button class="primary" type="submit">创建</button></div></form>`);
    $('#fC').onsubmit = async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      b.auto_renewal = b.auto_renewal === 'true';
      if (!b.amount) delete b.amount;
      try { const r = await api('/contracts', { method: 'POST', body: b }); toast('已创建 ' + r.contract_no); openContract(r.id); render(); }
      catch (err) { toast(err.message, true); }
    };
  });
}
window.newContract = newContract;

async function openContract(id) {
  S.detailId = id; S.tab = 'overview';
  await renderContract();
}
async function renderContract() {
  const id = S.detailId;
  const d = await api('/contracts/' + id);
  const c = d.contract, a = d.amount_summary;
  const tabs = [['overview', '概览'], ['items', '明细'], ['plans', `付款计划(${d.payment_plans.length})`],
  ['delivery', `交付(${d.deliveries.length})`], ['acceptance', `验收(${d.acceptances.length})`],
  ['invoice', `开票(${d.invoices.length})`], ['payment', `回款(${d.payments.length})`],
  ['versions', '版本'], ['attachments', `附件(${d.attachments.length})`], ['logs', '推进记录']];

  let body = '';
  if (S.tab === 'overview') body = tabOverview(d);
  else if (S.tab === 'items') body = tabItems(d);
  else if (S.tab === 'plans') body = tabPlans(d);
  else if (S.tab === 'delivery') body = tabDelivery(d);
  else if (S.tab === 'acceptance') body = tabAcceptance(d);
  else if (S.tab === 'invoice') body = tabInvoice(d);
  else if (S.tab === 'payment') body = tabPayment(d);
  else if (S.tab === 'versions') body = tabVersions(d);
  else if (S.tab === 'attachments') body = tabAttachments(d);
  else if (S.tab === 'logs') body = tabLogs(d);

  openDrawer(`${esc(c.contract_no)}`, `
    <div class="card" style="padding:12px 14px">
      <div style="font-weight:600;font-size:15px">${esc(c.name)}</div>
      <div class="row" style="margin-top:6px;flex-wrap:wrap">
        ${tag(c.status)}${c.is_archived ? '<span class="tag t-gray">已归档</span>' : ''}
        <span class="muted">${esc(c.customer_name)}</span>
        <span class="muted">负责人 ${esc(c.owner_name || '—')}</span>
        <span class="muted">服务期 ${esc(c.service_start_date)} ~ ${esc(c.service_end_date)}</span>
      </div>
      <div class="grid4" style="margin-top:10px">
        <div><div class="muted">合同金额</div><b>${a.contract_amount === null ? '不适用' : yuan(a.contract_amount)}</b></div>
        <div><div class="muted">已开票</div><b>${yuan(a.invoice_amount)}</b></div>
        <div><div class="muted">已回款</div><b>${yuan(a.paid_amount)}</b></div>
        <div><div class="muted">未回款</div><b style="${a.unpaid_amount && a.unpaid_amount !== '0.00' ? 'color:#A32D2D' : ''}">${a.unpaid_amount === null ? '不适用' : yuan(a.unpaid_amount)}</b></div>
      </div>
      ${a.paid_rate !== null ? `<div class="bar"><i style="width:${Math.min(100, Number(a.paid_rate))}%"></i></div>
        <div class="muted" style="margin-top:4px">回款率 ${a.paid_rate}%</div>` : ''}
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" onclick="setTab('${k}')">${l}</button>`).join('')}</div>
    ${body}`);
}
window.openContract = openContract;
async function setTab(t) { S.tab = t; await renderContract(); }
window.setTab = setTab;

function contractActions(d) {
  const c = d.contract;
  let h = '<div class="row wrap" style="margin-bottom:8px">';
  h += `<button class="primary" onclick="exportDoc('contracts','${c.id}','docx')">导出 Word</button>`;
  h += `<button onclick="exportDoc('contracts','${c.id}','print')">打印 / 另存 PDF</button>`;
  h += `<button onclick="setTab('attachments')">导入盖章件</button>`;
  h += `<button onclick="askQA('${c.id}')">问条款</button>`;
  h += '</div><div class="row wrap" style="margin-bottom:10px">';
  d.allowed_transitions.forEach((t) => h += `<button onclick="advance('contracts','${c.id}','${t}')">推进为「${t}」</button>`);
  h += c.is_archived ? `<button onclick="arch('${c.id}',0)">取消归档</button>` : `<button onclick="arch('${c.id}',1)">归档</button>`;
  h += `<button onclick="newVersion('${c.id}')">创建版本</button>`;
  h += '</div>';
  if (d.current_version) h += `<div class="card"><div class="muted" style="margin-bottom:6px">当前正文 ${esc(d.current_version.version_no)}（条款问答的输入源）</div>
    <div style="max-height:340px;overflow:auto;font-size:12.5px;line-height:1.7">${d.current_version.content}</div></div>`;
  return h;
}

function exportDoc(kind, id, fmt) {
  try {
    if (kind === 'contracts') exportContractDocument(id, fmt);
    else exportQuotationDocument(id, fmt);
  } catch (e) { toast(e.message, true); }
}
window.exportDoc = exportDoc;
async function arch(id, v) {
  try { await api(`/contracts/${id}/archive`, { method: v ? 'POST' : 'DELETE' }); toast(v ? '已归档' : '已取消归档'); renderContract(); }
  catch (e) { toast(e.message, true); }
}
window.arch = arch;

function askQA(id) { go('assistant'); setTimeout(() => { S.context = { contract_id: id }; startConv(true); }, 30); }
window.askQA = askQA;

function tabOverview(d) {
  const c = d.contract, st = d.process_stage;
  const order = ['quotation', 'contract', 'delivery', 'acceptance', 'invoice', 'payment', 'close'];
  const names = { quotation: '报价', contract: '签约', delivery: '交付', acceptance: '验收', invoice: '开票', payment: '回款', close: '完结' };
  return `
    <div class="stages" style="margin-bottom:12px">${order.map((k) => `<div class="stage ${STAGE_CLS[st.stages[k]] || ''}">${names[k]}<br/>${esc(st.stages[k] || '')}</div>`).join('')}</div>
    ${contractActions(d)}
    <h2 class="sec">关键字段</h2>
    <div class="card"><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><div class="muted">合同类型</div>${esc(c.contract_type)}</div>
      <div><div class="muted">金额口径</div>${esc(c.amount_type)}</div>
      <div><div class="muted">签署日期</div>${esc(c.sign_date || '—')}</div>
      <div><div class="muted">约定交付日期</div>${esc(c.planned_delivery_date || '—')}</div>
      <div><div class="muted">自动续约</div>${c.auto_renewal ? '是' : '否'}</div>
      <div><div class="muted">来源报价单</div>${d.source_quotation ? esc(d.source_quotation.quotation_no) : '—（直接创建）'}</div>
      <div><div class="muted">币种</div>${esc(c.currency)}</div>
      <div><div class="muted">当前版本</div>${esc(c.current_version_no)}</div>
    </div>
    <div style="margin-top:8px"><div class="muted">付款条件</div>${esc(c.payment_terms || '—')}</div></div>`;
}

function tabItems(d) {
  return `<div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>项目</th><th>规格</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th></tr></thead><tbody>
    ${d.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.spec || '—')}</td><td class="num">${esc(i.quantity)}</td><td class="num">${yuan(i.unit_price)}</td><td class="num">${yuan(i.amount)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">无明细</td></tr>'}
  </tbody></table></div>
  <div class="muted" style="margin-top:8px">合同明细与报价单明细结构一致，报价转合同时自动复制。</div>`;
}

function tabPlans(d) {
  return `${d.has_overpayment ? '<div class="card" style="border-color:#E8CE9B;background:#FFFDF7">存在超付，请核对回款金额与合同金额。</div>' : ''}
  <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th class="num">期次</th><th class="num">约定金额</th><th>约定回款日期</th><th class="num">已核销</th><th>状态</th></tr></thead><tbody>
    ${d.payment_plans.map((p) => `<tr><td class="num">第 ${p.seq_no} 期</td><td class="num">${yuan(p.plan_amount)}</td>
      <td>${esc(p.due_date)}</td><td class="num">${yuan(p.allocated_amount)}</td>
      <td>${tag({ '已回款': '已签收', '部分回款': '待签收', '逾期': '异常', '未到期': '草稿' }[p.status])} ${esc(p.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">未设置付款计划</td></tr>'}
  </tbody></table></div>
  <div class="row" style="margin-top:10px"><button onclick="addPlan('${d.contract.id}')">新增期次</button></div>
  <div class="muted" style="margin-top:8px">核销规则：先按回款记录指定的期次直接归属；未指定的按到期日顺序依次冲抵。此处的「已核销」为实时计算结果，不落库。</div>`;
}
function addPlan(cid) {
  openDrawer('新增付款期次', `<form id="fP">
    <div class="grid2"><div class="field"><label class="f">期次</label><input name="seq_no" type="number" value="${(S._planN || 1)}"/></div>
    <div class="field"><label class="f">约定金额 *</label><input name="plan_amount" required/></div></div>
    <div class="field"><label class="f">约定回款日期 *</label><input type="date" name="due_date" required/></div>
    <div class="row"><button class="primary" type="submit">保存</button></div></form>`);
  $('#fP').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/contracts/${cid}/payment-plans`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('已新增'); renderContract(); }
    catch (err) { toast(err.message, true); }
  };
}
window.addPlan = addPlan;

function recForm(kind, cid, today = true) {
  const f = {
    delivery: [['content', '交付内容 *'], ['quantity', '数量'], ['ship_date', '发货日期 *', 'date'],
    ['logistics_no', '物流单号'], ['receipt_status', '签收状态', 'sel:待签收,已签收,异常'], ['receipt_date', '签收日期', 'date'], ['remark', '备注']],
    acceptance: [['accept_date', '验收日期 *', 'date'], ['result', '验收结果 *', 'sel:待验收,通过,不通过'], ['remark', '备注']],
    invoice: [['invoice_no', '发票号 *'], ['invoice_date', '开票日期 *', 'date'], ['amount', '金额 *'],
    ['receipt_status', '签收状态', 'sel:待签收,已签收'], ['remark', '备注']],
    payment: [['received_date', '到账日期 *', 'date'], ['amount', '金额 *'], ['serial_no', '流水号'], ['remark', '备注']],
  }[kind];
  return `<form id="fR">${f.map(([n, l, t]) => {
    if (String(t || '').startsWith('sel:')) {
      const opts = String(t).slice(4).split(',');
      return `<div class="field"><label class="f">${l}</label><select name="${n}">${opts.map((o, i) => `<option>${o}</option>`).join('')}</select></div>`;
    }
    const dflt = t === 'date' ? `value="${new Date().toISOString().slice(0, 10)}"` : '';
    return `<div class="field"><label class="f">${l}</label><input name="${n}" ${t === 'date' ? 'type="date"' : ''} ${dflt}/></div>`;
  }).join('')}<div class="row"><button class="primary" type="submit">保存</button></div></form>`;
}
function openRec(kind, cid) {
  const label = { delivery: '交付记录', acceptance: '验收记录', invoice: '开票记录', payment: '回款记录' }[kind];
  openDrawer('录入' + label, recForm(kind, cid));
  $('#fR').onsubmit = async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    Object.keys(b).forEach((k) => { if (b[k] === '') delete b[k]; });
    try {
      const r = await api(`/contracts/${cid}/${kind === 'payment' ? 'payments' : kind + 's'}`, { method: 'POST', body: b });
      let extra = '';
      if (r.allocation) extra = '；该合同已回款 ' + yuan(r.amount_summary.paid_amount) + (r.allocation.has_overpayment ? '（存在超付）' : '');
      toast('已录入' + extra); S.tab = kind === 'payment' ? 'payment' : kind; renderContract(); refreshBadges();
    } catch (err) { toast(err.message, true); }
  };
}
window.openRec = openRec;

function recTable(rows, cols, kind, cid) {
  return `<div class="card" style="padding:0;overflow:auto"><table><thead><tr>${cols.map((c) => `<th class="${c[2] ? 'num' : ''}">${c[1]}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c[2] ? 'num' : ''}">${c[3] ? c[3](r) : esc(r[c[0]] ?? '—')}</td>`).join('')}
      <td style="width:50px"><button class="ghost" onclick="delRec('${kind}','${r.id}')">删</button></td></tr>`).join('')
    || `<tr><td colspan="${cols.length + 1}" class="empty">暂无记录</td></tr>`}
  </tbody></table></div><div class="row" style="margin-top:10px"><button class="primary" onclick="openRec('${kind}','${cid}')">新增</button></div>`;
}
async function delRec(kind, rid) {
  if (!confirm('确认删除这条记录？（软删除，可在操作日志中追溯）')) return;
  const path = { delivery: 'deliveries', acceptance: 'acceptances', invoice: 'invoices', payment: 'payments' }[kind];
  try { await api(`/${path}/${rid}`, { method: 'DELETE' }); toast('已删除'); renderContract(); }
  catch (e) { toast(e.message, true); }
}
window.delRec = delRec;

const tabDelivery = (d) => recTable(d.deliveries, [['ship_date', '发货日期'], ['content', '交付内容'], ['quantity', '数量', 1], ['logistics_no', '物流单号'], ['receipt_status', '签收状态', 0, (r) => tag(r.receipt_status)], ['receipt_date', '签收日期']], 'delivery', d.contract.id);
const tabAcceptance = (d) => recTable(d.acceptances, [['accept_date', '验收日期'], ['result', '验收结果', 0, (r) => tag(r.result)], ['remark', '备注']], 'acceptance', d.contract.id);
const tabInvoice = (d) => recTable(d.invoices, [['invoice_no', '发票号'], ['invoice_date', '开票日期'], ['amount', '金额', 1, (r) => yuan(r.amount)], ['receipt_status', '签收状态', 0, (r) => tag(r.receipt_status)]], 'invoice', d.contract.id);
const tabPayment = (d) => recTable(d.payments, [['received_date', '到账日期'], ['amount', '金额', 1, (r) => yuan(r.amount)], ['serial_no', '流水号'], ['payment_plan_id', '冲抵期次', 0, (r) => r.payment_plan_id ? '已指定' : '按顺序自动']], 'payment', d.contract.id);

function tabVersions(d) {
  return `<div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>版本</th><th>变更摘要</th><th>创建时间</th></tr></thead><tbody>
    ${d.versions.map((v) => `<tr><td>${esc(v.version_no)}</td><td>${esc(v.change_summary || '')}</td><td class="muted">${esc((v.created_at || '').slice(0, 16).replace('T', ' '))}</td></tr>`).join('')}
  </tbody></table></div>`;
}
function newVersion(cid) {
  openDrawer('创建合同版本', `<form id="fV"><div class="field"><label class="f">变更摘要</label><input name="change_summary"/></div>
    <div class="field"><label class="f">正文（富文本 / HTML）</label><textarea name="content" rows="12"></textarea></div>
    <div class="row"><button class="primary" type="submit">创建</button></div></form>`);
  $('#fV').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api(`/contracts/${cid}/versions`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('已创建 ' + r.version_no); renderContract(); }
    catch (err) { toast(err.message, true); }
  };
}
window.newVersion = newVersion;

const DOC_KINDS = {
  CONTRACT: [['盖章扫描件', '盖章扫描件（签回的合同）'], ['合同正本', '合同正本（我方出具的）'], ['其他', '其他']],
  QUOTATION: [['报价单回签', '报价单回签（客户确认的）'], ['其他', '其他']],
};

function importPanel(objectType, objectId, allowed) {
  const kinds = DOC_KINDS[objectType] || DOC_KINDS.CONTRACT;
  const adv = (allowed || []).filter((t) => t !== '已作废');
  return `<div class="card">
    <div class="muted" style="margin-bottom:8px">批量导入扫描件存档 —— 支持一次多选，全部挂到本${objectType === 'CONTRACT' ? '合同' : '报价单'}下。</div>
    <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="field"><label class="f">存档类型</label>
        <select id="impKind">${kinds.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      ${objectType === 'CONTRACT' ? `<div class="field"><label class="f">导入后推进状态（可选）</label>
        <select id="impAdv"><option value="">不推进</option>${adv.map((t) => `<option>${t}</option>`).join('')}</select></div>` : ''}
    </div>
    <input type="file" id="impFiles" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"/>
    <div class="row" style="margin-top:10px"><button class="primary" onclick="importScans('${objectType}','${objectId}')">批量导入</button></div>
    <div class="muted" style="margin-top:8px">支持 PDF / JPG / PNG / DOC / DOCX，单文件不超过 50MB。
      附件不参与 AI 条款问答（MVP 不做 OCR），条款问答以合同正文为准。</div>
  </div>`;
}

async function importScans(objectType, objectId) {
  const input = $('#impFiles');
  if (!input.files.length) return toast('请先选择文件', true);
  const adv = $('#impAdv');
  try {
    const d = await importScansApi(objectType, objectId, $('#impKind').value,
      (adv && adv.value) ? adv.value : null, [...input.files]);
    toast(`已导入 ${d.count} 个文件` + (d.advanced_to ? `，并推进为「${d.advanced_to}」` : '')
      + (d.rejected && d.rejected.length ? `；${d.rejected.length} 个被拒` : ''));
    await renderContract();
    refreshBadges();
  } catch (e) { toast(e.message, true); }
}
window.importScans = importScans;

function attachmentTable(list) {
  return `<div class="card" style="padding:0;overflow:auto"><table><thead><tr>
      <th>文件名</th><th>类型</th><th>存档分类</th><th class="num">大小</th><th>上传时间</th><th>参与问答</th></tr></thead><tbody>
    ${list.map((a) => `<tr><td><a href="javascript:void(0)" onclick="downloadAttach('${a.id}')">${esc(a.file_name)}</a></td>
      <td>${esc(a.file_type)}</td><td>${tag(a.doc_kind)}</td><td class="num">${(a.file_size / 1024).toFixed(0)} KB</td>
      <td class="muted">${esc((a.uploaded_at || '').slice(0, 16).replace('T', ' '))}</td>
      <td>${a.join_ai_qa ? '是' : '否'}</td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">暂无附件</td></tr>'}
  </tbody></table></div>`;
}

async function downloadAttach(id) {
  try { await downloadAttachment(id); }
  catch (e) { toast(e.message, true); }
}
window.downloadAttach = downloadAttach;

function tabAttachments(d) {
  const cid = d.contract.id;
  return importPanel('CONTRACT', cid, d.allowed_transitions) + attachmentTable(d.attachments);
}

function tabLogs(d) {
  return `<div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>时间</th><th>变更</th><th>操作人</th><th>来源</th><th>备注</th></tr></thead><tbody>
    ${d.status_logs.map((s) => `<tr><td class="muted">${esc((s.changed_at || '').slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(s.from_status || '—')} → <b>${esc(s.to_status)}</b></td><td>${esc(s.operator_name || '系统')}</td>
      <td>${tag(s.source)}</td><td class="muted">${esc(s.remark || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无推进记录</td></tr>'}
  </tbody></table></div>
  <div class="muted" style="margin-top:8px">只有「客观时间事实」（报价失效、合同到期）由系统自动流转，其余状态变更均由人推动并在此留痕。</div>`;
}

/* ================= 模板 ================= */
async function viewTemplates(v) {
  const d = await api('/templates');
  const types = ['报价单', '销售合同', '服务合同', '保密协议', '其他'];
  const groups = types.map((t) => ({ t, list: d.list.filter((x) => x.template_type === t) })).filter((g) => g.list.length);
  v.innerHTML = `
    <div class="card">
      <div class="row wrap">
        <span class="muted">共 ${d.list.length} 个模板</span>
        <span class="grow"></span>
        <label class="row" style="gap:5px"><input type="checkbox" id="tOnlyQ" style="width:auto"/><span class="muted">只看报价单模板</span></label>
        <label class="row" style="gap:5px"><input type="checkbox" id="tOnlyC" style="width:auto"/><span class="muted">只看合同模板</span></label>
      </div>
      <div class="muted" style="margin-top:8px">模板用于<b>对外出文档</b>：报价单按模板渲染后发给客户，合同按模板生成正文。
        变量分两类 —— 标量 <span class="mono">{{客户名称}}</span> 取关联对象字段，表格型 <span class="mono">{{明细表}}</span> 渲染为明细表格。</div>
    </div>
    <div id="tplBox"></div>`;

  const draw = () => {
    const onlyQ = $('#tOnlyQ').checked, onlyC = $('#tOnlyC').checked;
    const show = groups.filter((g) => !onlyQ || g.t === '报价单').filter((g) => !onlyC || g.t !== '报价单');
    $('#tplBox').innerHTML = show.map((g) => `
      <h2 class="sec">${esc(g.t)}（${g.list.length}）</h2>
      <div class="grid3">${g.list.map((t) => `<div class="card">
        <div class="row"><b>${esc(t.name)}</b><span class="grow"></span>${tag(t.status)}</div>
        <div class="muted" style="margin-top:4px">${esc(t.template_type)} · ${esc(t.current_version_no)}</div>
        <div class="muted" style="margin-top:8px">变量 ${(t.variables || []).length} 个</div>
        <div class="chips" style="margin-top:6px">${(t.variables || []).map((x) => `<span class="chip mono">{{${esc(x)}}}</span>`).join('')}</div>
        <div class="row" style="margin-top:10px"><button onclick="openTemplate('${t.id}')">查看正文</button></div>
      </div>`).join('')}</div>`).join('') || '<div class="empty">没有符合条件的模板</div>';
  };
  $('#tOnlyQ').onchange = () => { if ($('#tOnlyQ').checked) $('#tOnlyC').checked = false; draw(); };
  $('#tOnlyC').onchange = () => { if ($('#tOnlyC').checked) $('#tOnlyQ').checked = false; draw(); };
  draw();
}
window.viewTemplates = viewTemplates;
async function openTemplate(id) {
  const d = await api('/templates/' + id);
  openDrawer(esc(d.template.name), `<div class="muted" style="margin-bottom:8px">${esc(d.template.source_note || '')}</div>
    <div class="card" style="font-size:12.5px;line-height:1.75">${d.content}</div>`);
}
window.openTemplate = openTemplate;

/* ================= 提醒 ================= */
const REMIND_TARGET = { CONTRACT: '合同', QUOTATION: '报价单' };

function openReminderTarget(type, id) {
  if (type === 'CONTRACT') return openContract(id);
  if (type === 'QUOTATION') return openQuotation(id);
  toast('该提醒没有可跳转的对象');
}

function reminderTargetHtml(r) {
  if (!r.target_exists) return '<div class="rtarget gone">关联对象已删除</div>';
  const t = REMIND_TARGET[r.object_type] || '对象';
  const bits = [r.target_no, r.target_name, r.customer_name].filter(Boolean).map(esc);
  return `<div class="rtarget"><span class="arrow">→</span>${t} ${bits.join(' · ')}</div>`;
}

async function viewReminders(v) {
  const d = await api('/reminders');
  $('#headExtra').innerHTML = '<button onclick="scan()">立即扫描</button> <button onclick="readAll()">全部已读</button>';
  v.innerHTML = `<div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>类型</th><th>内容与关联业务</th><th>触发时间</th><th>状态</th><th></th></tr></thead><tbody>
    ${d.list.map((r) => {
      const canOpen = !!r.target_exists;
      return `<tr class="${canOpen ? 'clickable' : ''}"${canOpen ? ` onclick="openReminderTarget('${r.object_type}','${r.object_id}')" title="点击查看关联业务"` : ''}>
      <td>${tag(r.remind_type)}</td>
      <td>${esc(r.content)}${reminderTargetHtml(r)}</td>
      <td class="muted">${esc((r.triggered_at || '').slice(0, 16).replace('T', ' '))}</td>
      <td>${r.is_read ? '<span class="muted">已读</span>' : '<span class="tag t-red">未读</span>'}</td>
      <td>${r.is_read ? '' : `<button class="ghost" onclick="event.stopPropagation();readOne('${r.id}')">标记已读</button>`}</td></tr>`;
    }).join('')
    || '<tr><td colspan="5" class="empty">暂无提醒</td></tr>'}
  </tbody></table></div>
  <div class="muted" style="margin-top:8px">点击任意一条即可跳到关联的合同 / 报价单（「标记已读」按钮不会触发跳转）。<br/>去重规则：同一对象 + 同一类型同时只保留一条未读提醒（「合同到期 30/15/7 天」三次触发只会更新同一条，不会堆三条）。</div>`;
}
async function readOne(id) { await api(`/reminders/${id}/read`, { method: 'PATCH' }); render(); refreshBadges(); }
async function readAll() { await api('/reminders/read-all', { method: 'POST' }); toast('已全部标记'); render(); refreshBadges(); }
async function scan() { const r = await api('/reminders/scan', { method: 'POST' }); toast(`扫描完成，新增 ${r.reminder_scan.created} 条`); render(); refreshBadges(); }
window.readOne = readOne; window.readAll = readAll; window.scan = scan; window.openReminderTarget = openReminderTarget;

/* ================= 智能助手 ================= */
const EXAMPLES = [
  '本月签了多少合同', '哪些单卡住了', '报价转化率是多少',
  'A 客户还有多少没回', '恒美那个合同签了，往下推', '宏远科技今天回款 20 万',
  '把宏远那个合同删了', 'A 公司和 B 公司都回款了',
];

async function viewAssistant(v) {
  v.innerHTML = `<div class="chatwrap" style="height:calc(100vh - 130px)">
    <div class="msgs" id="msgs"></div>
    <div>
      <div class="chips" id="chips">${EXAMPLES.map((e) => `<span class="chip" onclick="quick(${JSON.stringify(e).replace(/"/g, '&quot;')})">${esc(e)}</span>`).join('')}</div>
      <div class="composer">
        <textarea id="input" placeholder="说一句话：查数据、录记录、推进度、问条款…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="primary" id="send" style="height:42px">发送</button>
      </div>
      <div class="muted" style="margin-top:6px" id="ctxHint"></div>
    </div></div>`;
  if (!S.conv) await startConv(false);
  else await loadMsgs();
  $('#send').onclick = send;
  $('#input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('#input').focus();
}
window.viewAssistant = viewAssistant;

async function startConv(reopen) {
  const r = await api('/assistant/conversations', { method: 'POST', body: { context: S.context, title: '业务咨询' } });
  S.conv = r.id;
  if (reopen) { render(); return; }
  $('#msgs') && (await loadMsgs());
}
window.startConv = startConv;

async function loadMsgs() {
  const msgs = await api(`/assistant/conversations/${S.conv}/messages`);
  const box = $('#msgs'); if (!box) return;
  box.innerHTML = '';
  if (!msgs.length) {
    box.innerHTML = `<div class="msg a">我是业务通助手。可以直接说一句话，比如：<br/>· 「本月签了多少合同」<br/>· 「宏远科技今天回款 20 万」<br/>· 「恒美那个合同签了，往下推」<br/>· 「这份合同的付款条件是什么」<br/><div class="meta">写操作分三级：一级直接执行可撤销，二级出示确认卡，删除/终止这类一律拒绝并引导到详情页。</div></div>`;
  }
  msgs.forEach((m) => {
    addMsg(m.role, m.content, m.payload ? (typeof m.payload === 'string' ? JSON.parse(m.payload) : m.payload) : null);
  });
  const h = $('#ctxHint');
  if (h) h.textContent = S.context.contract_id ? '已带入合同上下文：从合同详情页进入，可直接问条款' : '';
  box.scrollTop = box.scrollHeight;
}

function addMsg(role, text, payload) {
  const box = $('#msgs'); if (!box) return null;
  const el = document.createElement('div');
  el.className = 'msg ' + (role === 'user' ? 'u' : 'a');
  el.innerHTML = esc(text);
  if (role === 'assistant' && payload) {
    // 兼容两种存档格式：早期只存了 events 数组，现在存 {events, entities}
    const legacy = Array.isArray(payload);
    attachAnswerExtras(el, legacy ? null : payload.entities, legacy ? payload : payload.events);
  }
  box.appendChild(el); box.scrollTop = box.scrollHeight;
  return el;
}

/* 回答的附加内容：可跳转入口在前，系统细节在后 */
function attachAnswerExtras(el, entities, events) {
  const links = renderEntities(entities);
  if (links) el.appendChild(links);
  const ev = renderEvents(events);
  if (ev && ev.childElementCount) el.appendChild(ev);
}

/* ---------- 可点击的实体入口 ---------- */
const ENTITY_LABEL = { contract: '合同', quotation: '报价单', customer: '客户' };

function jumpToEntity(e) {
  if (!e || !e.id) return;
  const fn = { contract: openContract, quotation: openQuotation, customer: openCustomer }[e.type];
  if (!fn) { toast('暂不支持跳转到该类型：' + e.type); return; }
  fn(e.id);
}

function renderEntities(list) {
  const arr = (list || []).filter((e) => e && e.id && e.type);
  if (!arr.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'elinks';
  arr.forEach((e) => {
    const s = document.createElement('span');
    s.className = 'elink';
    s.innerHTML = `<span class="k">${ENTITY_LABEL[e.type] || '对象'}</span>${esc(e.label || e.id)}`;
    s.onclick = () => jumpToEntity(e);
    wrap.appendChild(s);
  });
  return wrap;
}

function sys(text, cls = '') { const d = document.createElement('div'); d.className = 'sys ' + cls; d.textContent = text; return d; }

/* 数据来源卡片：给人看的说明放正文，原始查询收进折叠区 */
function sourceCard(e) {
  const d = document.createElement('div');
  d.className = 'src';

  const head = document.createElement('div');
  head.className = 'src-h';
  head.innerHTML = `<span class="k">数据来源</span><b>${esc(e.label || '台账')}</b>`
    + (e.rowcount != null ? `<span class="n">命中 ${e.rowcount} 条</span>` : '');
  d.appendChild(head);

  if (e.definition) {
    const l = document.createElement('div');
    l.className = 'src-l';
    l.textContent = /^口径/.test(e.definition) ? e.definition : '口径：' + e.definition;
    d.appendChild(l);
  }
  if (e.detail) {
    const l = document.createElement('div');
    l.className = 'src-l';
    l.textContent = '依据：' + e.detail;
    d.appendChild(l);
  }
  if (e.sql) {
    const det = document.createElement('details');
    const sm = document.createElement('summary');
    sm.textContent = '查看查询明细';
    const pre = document.createElement('pre');
    pre.textContent = e.sql;
    det.append(sm, pre);
    d.appendChild(det);
  }

  // 指标类回答是聚合数字，没有单条实体可点，给一个模块入口兜底，
  // 否则用户看完数字想"去对应页面看看"时无处可去。
  if (e.kind === 'metric') {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = '查看业务进程';
    b.style.marginTop = '8px';
    b.onclick = () => go('process');
    d.appendChild(b);
  }
  return d;
}

function renderEvents(events) {
  const wrap = document.createElement('div');
  (events || []).forEach((e) => {
    if (e.event === 'confirm_card') wrap.appendChild(confirmCard(e));
    else if (e.event === 'clarify') wrap.appendChild(clarifyBlock(e));
    else if (e.event === 'rejected') wrap.appendChild(sys(`已拒绝：${e.message}`, 'bad'));
    else if (e.event === 'result') {
      const ok = sys('✓ ' + e.message + (e.undoable ? '（可撤销）' : ''));
      if (e.undoable && e.log_id) {
        const b = document.createElement('button'); b.className = 'ghost'; b.textContent = '撤销这一步';
        b.onclick = async () => {
          try { const r = await api(`/assistant/actions/${e.log_id}/undo`, { method: 'POST' }); ok.textContent = '✓ ' + (r.reply || '已撤销'); b.remove(); refreshBadges(); }
          catch (err) { toast(err.message, true); }
        };
        ok.appendChild(document.createElement('br')); ok.appendChild(b);
      }
      if (e.allocation) {
        const t = document.createElement('div');
        t.innerHTML = e.allocation.plans.map((p) => `第 ${p.seq_no} 期 ${p.plan_amount} 元 → ${esc(p.status)}`).join(' · ');
        ok.appendChild(t);
      }
      wrap.appendChild(ok);
    }
    else if (e.event === 'sources') wrap.appendChild(sourceCard(e));
    else if (e.event === 'citation') wrap.appendChild(sys('原文依据：' + (e.excerpt || '（未标注）')));
    else if (e.event === 'disclaimer') wrap.appendChild(sys(e.text, 'warn'));
    else if (e.event === 'degraded') wrap.appendChild(sys('⚠ ' + (e.message || 'AI 服务暂不可用，台账与表单不受影响'), 'bad'));
    else if (e.event === 'blocked') wrap.appendChild(sys('已拦截不安全的查询：' + e.reason, 'bad'));
    else if (e.event === 'non_queryable') wrap.appendChild(sys('该字段未结构化，无法统计查询', 'warn'));
    else if (e.event === 'error') wrap.appendChild(sys('执行出错：' + e.detail, 'bad'));
    else if (e.event === 'unknown') wrap.appendChild(sys('未识别为可执行动作，已给出引导'));
    else if (e.event === 'refused') wrap.appendChild(sys('超出能力范围，已明确拒答', 'warn'));
    else if (e.event === 'intent') wrap.appendChild(sys(`意图：${e.intent}${e.level ? ' · 风险级别 ' + e.level : ''}`));
  });
  return wrap;
}

function clarifyBlock(e) {
  const d = document.createElement('div');
  d.className = 'sys warn';
  d.textContent = e.message;
  if (e.parsed_so_far && Object.keys(e.parsed_so_far).length) {
    const p = document.createElement('div');
    p.textContent = '已识别：' + Object.entries(e.parsed_so_far).map(([k, v]) => `${k}=${v}`).join('、');
    d.appendChild(p);
  }
  const cs = e.candidates || [];
  if (cs.length) {
    const box = document.createElement('div'); box.className = 'chips'; box.style.marginTop = '6px';
    cs.forEach((c) => {
      const b = document.createElement('span'); b.className = 'chip';
      b.textContent = `${c.label}${c.hint ? '（' + c.hint + '）' : ''}`;
      b.onclick = () => quick(c.label);
      box.appendChild(b);
    });
    d.appendChild(box);
  }
  return d;
}

function confirmCard(e) {
  const d = document.createElement('div');
  d.className = 'card-confirm';
  const rows = (e.changes || []).map((c) => `<tr><td>${esc(c.label)}</td><td><span class="from">${esc(c.from ?? '—')}</span> → <span class="to">${esc(c.to ?? '')}</span></td></tr>`).join('');
  d.innerHTML = `<div><b>二级操作 · 需要你确认</b> <span class="muted">${esc(e.action_type)}</span></div>
    <div style="margin:6px 0">对象：<b>${esc(e.target?.label || '')}</b></div>
    <table>${rows}</table>
    ${e.impact ? `<div class="muted" style="margin-top:6px">影响：${esc(e.impact)}</div>` : ''}
    <div class="muted" style="margin-top:4px">确认卡有效期 10 分钟 · 只能确认一次</div>`;
  const bar = document.createElement('div'); bar.className = 'row'; bar.style.marginTop = '8px';
  const okb = document.createElement('button'); okb.className = 'primary'; okb.textContent = '确认执行';
  const cb = document.createElement('button'); cb.textContent = '取消';
  okb.onclick = async () => {
    okb.disabled = cb.disabled = true;
    try {
      const r = await api(`/assistant/actions/${e.action_id}/confirm`, { method: 'POST' });
      d.innerHTML = `<div class="sys">✓ 已执行：${esc(r.reply)}</div>`;
      refreshBadges();
    } catch (err) { d.innerHTML = `<div class="sys bad">${esc(err.message)}</div>`; }
  };
  cb.onclick = async () => {
    await api(`/assistant/actions/${e.action_id}/cancel`, { method: 'POST' });
    d.innerHTML = '<div class="sys">已取消，数据没有发生任何变化。</div>';
  };
  bar.append(okb, cb); d.appendChild(bar);
  return d;
}

function quick(t) { const i = $('#input'); i.value = t; send(); }
window.quick = quick;

async function send() {
  const i = $('#input'); const text = i.value.trim();
  if (!text) return;
  i.value = ''; addMsg('user', text);
  const ph = addMsg('assistant', '正在理解…');
  try {
    const r = await api(`/assistant/conversations/${S.conv}/messages`, { method: 'POST', body: { content: text, context: S.context } });
    ph.innerHTML = esc(r.reply || '');
    attachAnswerExtras(ph, r.entities, r.events);
  } catch (e) { ph.innerHTML = esc('出错了：' + e.message); }
  $('#msgs').scrollTop = $('#msgs').scrollHeight;
  refreshBadges();
}

/* ================= 设置 ================= */
async function viewSettings(v) {
  const s = await api('/settings');
  const th = s.stagnation_threshold || {};
  v.innerHTML = `
  <div class="grid3">
    <div class="kpi"><div class="l">当前操作人</div><div class="v sm">${esc((S.operators.find((o) => o.id === s.current_operator_id) || {}).name || '—')}</div></div>
    <div class="kpi"><div class="l">AI 能力</div><div class="v sm">${s.ai_enabled ? '已开启' : '已关闭'}</div></div>
    <div class="kpi"><div class="l">条款问答</div><div class="v sm">${s.ai_contract_qa_enabled ? '已开启' : '已关闭'}</div></div>
  </div>

  <h2 class="sec">AI 模型接入（网页版）</h2>
  <div class="card">
    <div class="muted">这是<b>纯前端网页版</b>：没有后端服务器。数据库在浏览器内运行，AI 调用由浏览器直连 DeepSeek，
      所以模型 Key 需要你自己填写。Key 只保存在本浏览器 localStorage，只发往 api.deepseek.com。</div>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label class="f">DeepSeek API Key</label><input id="cfgKey" type="password" placeholder="sk-..."/></div>
      <div class="field"><label class="f">模型</label><input id="cfgModel" type="text" placeholder="deepseek-chat"/></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="primary" onclick="saveKey()">保存 Key</button>
      <button onclick="clearKey()">清除 Key</button>
      <span class="muted" id="keyState"></span>
    </div>
    <div class="muted" style="margin-top:8px">当前 Key：<span class="mono" id="keyMask">—</span></div>
  </div>

  <h2 class="sec">停滞阈值（业务进程的停滞判定依据）</h2>
  <div class="card">
    <div class="grid4">
      <div class="field"><label class="f">签约阶段（天）</label><input id="th1" type="number" value="${th.signing_days ?? 15}"/></div>
      <div class="field"><label class="f">验收阶段（天）</label><input id="th2" type="number" value="${th.acceptance_days ?? 30}"/></div>
      <div class="field"><label class="f">开票阶段（天）</label><input id="th3" type="number" value="${th.invoice_days ?? 30}"/></div>
      <div class="field"><label class="f">交付阶段（天）</label><input id="th4" type="number" value="${th.delivery_days ?? 30}"/></div>
    </div>
    <div class="row"><button class="primary" onclick="saveTh()">保存阈值</button></div>
  </div>

  <h2 class="sec">AI 能力开关</h2>
  <div class="card">
    <label class="row" style="gap:8px"><input type="checkbox" id="aiOn" style="width:auto" ${s.ai_enabled ? 'checked' : ''}/><span>启用 AI 能力（关闭后台账、录入、提醒照常可用）</span></label>
    <label class="row" style="gap:8px;margin-top:6px"><input type="checkbox" id="qaOn" style="width:auto" ${s.ai_contract_qa_enabled ? 'checked' : ''}/><span>启用条款问答（合同正文会发送至模型服务）</span></label>
    <div class="row" style="margin-top:10px"><button class="primary" onclick="saveAi()">保存</button></div>
  </div>

  <h2 class="sec">AI 连通性自检</h2>
  <div class="card">
    <div class="row"><button onclick="testAi()">测试连接</button><span class="muted" id="aiTestTip">助手答不上来时，先点这里确认模型服务是否可达</span></div>
    <div id="aiTestOut" class="muted" style="margin-top:8px;line-height:1.7"></div>
    <div class="muted" style="margin-top:8px">AI 是加速器不是地基：模型不可用时，台账、录入、状态推进、提醒、进程看板不受影响，
      只有需要"理解一句话"的功能会退化。</div>
  </div>

  <h2 class="sec">提示词在哪改</h2>
  <div class="card">
    <div class="muted">四段提示词集中在 <span class="mono">js/prompts.js</span>（本地版对应 <span class="mono">app/prompts.py</span>），改完刷新页面生效：</div>
    <div class="muted" style="margin-top:6px;line-height:1.8">
      · <span class="mono">INTENT_SYSTEM</span> —— 意图识别与槽位抽取<br/>
      · <span class="mono">SCHEMA_HINT</span> —— 自然语言转 SQL（含"必须自报口径"的要求）<br/>
      · <span class="mono">QA_SYSTEM</span> —— 合同条款问答<br/>
      · <span class="mono">POLISH_SYSTEM</span> —— 结果润色
    </div>
    <div class="muted" style="margin-top:8px;line-height:1.7">动作清单和指标口径是从 <span class="mono">js/catalog.js</span>
      动态注入的，不要在提示词里手写；风险分级刻意不写进任何提示词 —— 写进去模型就会自我说服。</div>
  </div>

  <h2 class="sec">操作人</h2>
  <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>姓名</th><th>状态</th></tr></thead><tbody>
    ${S.operators.map((o) => `<tr><td>${esc(o.name)}</td><td>${o.is_active ? '启用' : '停用'}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="row" style="margin-top:10px"><input id="newOp" placeholder="新增操作人姓名" style="max-width:220px"/><button onclick="addOp()">添加</button></div>

  <h2 class="sec">数据导出与备份</h2>
  <div class="card">
    <div class="row wrap">
      <button class="btn" onclick="dlLedger('contract')">导出合同台账 CSV</button>
      <button class="btn" onclick="dlLedger('quotation')">导出报价台账 CSV</button>
      <button class="btn" onclick="dlLedger('payment')">导出回款台账 CSV</button>
      <button class="btn" onclick="dlBackup()">导出全量备份 JSON</button>
    </div>
    <div class="row" style="margin-top:10px">
      <button onclick="resetDemo()">清空并恢复演示数据</button>
    </div>
    <div class="muted" style="margin-top:8px">仅支持导出，不做批量导入。JSON 备份可用于迁移与容灾。
      本地数据存在这台设备的浏览器里，清空后不可恢复。</div>
  </div>

  <h2 class="sec">AI 能力边界（当前生效的口径）</h2>
  <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>指标</th><th>口径定义</th><th>单位</th></tr></thead><tbody>
    ${Object.entries(s.metrics).map(([k, m]) => `<tr><td><b>${esc(k)}</b></td><td class="muted">${esc(m.definition)}</td><td>${esc(m.unit)}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="muted" style="margin-top:8px">所有统计问题必须命中上表口径；未命中的指标不做估算，只回答"暂不支持统计该指标"。这是为了防止 AI 编数。</div>

  <h2 class="sec">写操作风险分级</h2>
  <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>级别</th><th>处理方式</th><th>动作</th></tr></thead><tbody>
    ${[1, 2, 3].map((lv) => {
    const acts = Object.entries(s.actions).filter(([, a]) => a.level === lv).map(([k, a]) => a.label);
    const way = { 1: '直接执行，可撤销', 2: '出示确认卡，确认后落库', 3: '永久拒绝，引导到详情页' }[lv];
    return `<tr><td>${{ 1: '一级', 2: '二级', 3: '三级' }[lv]}</td><td>${way}</td><td class="muted">${acts.map(esc).join('、')}</td></tr>`;
  }).join('')}
  </tbody></table></div>`;
  refreshKeyState();
}

/* ---------- 网页版：模型 Key 维护 ---------- */
function refreshKeyState() {
  const k = AI.getApiKey();
  const mask = $('#keyMask');
  if (mask) mask.textContent = k ? k.slice(0, 6) + '…' + k.slice(-4) : '未填写（AI 助手不可用，其余功能不受影响）';
  const ki = $('#cfgKey'); if (ki) ki.value = k || '';
  const mi = $('#cfgModel'); if (mi) mi.value = AI.getModel();
  const st = $('#keyState'); if (st) st.textContent = k ? '已配置' : '未配置';
}
function saveKey() {
  const k = $('#cfgKey').value.trim();
  if (!k) return toast('请填入 Key', true);
  AI.setApiKey(k);
  const m = $('#cfgModel').value.trim();
  if (m) localStorage.setItem('bizflow_deepseek_model', m);
  toast('已保存'); refreshKeyState();
}
function clearKey() {
  AI.setApiKey('');
  toast('已清除 Key，AI 助手将不可用'); refreshKeyState();
}
function dlLedger(t) { try { exportLedger(t); } catch (e) { toast(e.message, true); } }
function dlBackup() { try { exportBackup(); } catch (e) { toast(e.message, true); } }
async function resetDemo() {
  if (!confirm('会删除本浏览器里的全部业务数据，并恢复为初始演示素材。确定继续？')) return;
  try {
    await db.resetDatabase();   // 丢弃 IndexedDB 里的库，按 schema 重建
    // 附件字节另存一个库，一并清掉，避免留下孤立的文件残片
    await new Promise((r) => { try { const q = indexedDB.deleteDatabase('bizflow_files'); q.onsuccess = q.onerror = q.onblocked = () => r(); } catch { r(); } });
    seed.seedDatabase();        // 重新播种（与本地版 seed.py 同一套素材）
    db.persist();
    toast('已恢复演示数据');
    setTimeout(() => location.reload(), 400);   // 同时清掉内存里的会话与确认卡
  } catch (e) { toast('恢复失败：' + e.message, true); }
}
window.saveKey = saveKey; window.clearKey = clearKey;
window.dlLedger = dlLedger; window.dlBackup = dlBackup; window.resetDemo = resetDemo;

async function saveTh() {
  await api('/settings', { method: 'PATCH', body: { stagnation_threshold: { signing_days: +$('#th1').value, acceptance_days: +$('#th2').value, invoice_days: +$('#th3').value, delivery_days: +$('#th4').value } } });
  toast('阈值已保存'); render();
}
async function saveAi() {
  await api('/settings', { method: 'PATCH', body: { ai_enabled: $('#aiOn').checked, ai_contract_qa_enabled: $('#qaOn').checked } });
  toast('已保存'); render();
}

async function testAi() {
  const tip = $('#aiTestTip'), out = $('#aiTestOut');
  if (!tip || !out) return;
  tip.textContent = '正在连接模型服务…'; out.textContent = '';
  try {
    const r = await api('/settings/ai/test', { method: 'POST' });
    tip.textContent = '';
    if (r.ok) {
      out.innerHTML = `<span style="color:var(--teal-ink)">✓ 连通正常</span> · 模型 ${esc(r.model)}`
        + ` · 耗时 ${r.elapsed_ms} ms · 返回「${esc(r.reply)}」`;
    } else {
      out.innerHTML = `<span style="color:var(--red-ink)">✗ ${esc(r.stage)}失败</span><br/>`
        + `${esc(r.error)}<br/><br/>${esc(r.hint || '').replace(/\n/g, '<br/>')}`;
    }
  } catch (e) { tip.textContent = ''; out.textContent = '请求失败：' + e.message; }
}
window.testAi = testAi;
async function addOp() {
  const n = $('#newOp').value.trim(); if (!n) return;
  try { await api('/operators', { method: 'POST', body: { name: n } }); await loadOperators(); toast('已添加'); render(); }
  catch (e) { toast(e.message, true); }
}
window.saveTh = saveTh; window.saveAi = saveAi; window.addOp = addOp;

/* ================= 抽屉 ================= */
function openDrawer(title, html) {
  $('#drawerTitle').innerHTML = title;
  $('#drawerBody').innerHTML = html;
  $('#drawer').classList.add('on'); $('#scrim').classList.add('on');
}
function closeDrawer() {
  $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on');
}
window.openDrawer = openDrawer; window.closeDrawer = closeDrawer;
