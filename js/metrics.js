// metrics.js — 指标口径的唯一实现（平移自 metrics.py）。文档定义的口径一律确定性计算，模型不参与。
import * as db from "./db.js";
import * as proc from "./process.js";

function parse_range(text) {
  const t = db.today_str();
  const [y, m] = t.split("-").map(Number);
  const ymd = t;
  if (/本月|这个月|当月|本月份/.test(text)) return [`${y}-${String(m).padStart(2, "0")}-01`, ymd, `${y}年${m}月`];
  if (/上月|上个月/.test(text)) {
    const pm = m > 1 ? m - 1 : 12, py = m > 1 ? y : y - 1;
    const last = new Date(py, pm, 0).getDate();
    return [`${py}-${String(pm).padStart(2, "0")}-01`, `${py}-${String(pm).padStart(2, "0")}-${last}`, `${py}年${pm}月`];
  }
  if (/本季度|这个季度|当季/.test(text)) { const qs = Math.floor((m - 1) / 3) * 3 + 1; return [`${y}-${String(qs).padStart(2, "0")}-01`, ymd, `${y}年第${Math.floor((m - 1) / 3) + 1}季度`]; }
  if (/今年|本年度|本年|当年/.test(text)) return [`${y}-01-01`, ymd, `${y}年`];
  if (/去年|上一年/.test(text)) return [`${y - 1}-01-01`, `${y - 1}-12-31`, `${y - 1}年`];
  const mm = text.match(/近\s*([一二三四五六七八九十\d]+)\s*个?月|最近\s*([一二三四五六七八九十\d]+)\s*个?月/);
  if (mm) {
    const raw = mm[1] || mm[2];
    const cn = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
    let n = cn[raw] !== undefined ? cn[raw] : parseInt(raw.replace(/\D/g, "") || "3", 10);
    let sy = y, sm = m - n + 1;
    while (sm <= 0) { sm += 12; sy -= 1; }
    return [`${sy}-${String(sm).padStart(2, "0")}-01`, ymd, `近 ${n} 个月`];
  }
  return [null, null, "全部"];
}

function _in_range(day, start, end) {
  if (!day) return false;
  const d = day.slice(0, 10);
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

function customer_in_text(text) {
  const hits = {};
  for (const c of db.rows("SELECT id, name FROM customer WHERE is_deleted = 0")) {
    for (const n of [3, 2]) if (c.name.length >= n && c.name.slice(0, n).includes(text)) { hits[c.id] = c; break; }
  }
  const uniq = Object.values(hits);
  return uniq.length === 1 ? uniq[0] : null;
}

export function compute(text) {
  const [start, end, label] = parse_range(text);
  const cust = customer_in_text(text);
  const contracts = () => { let sql = "SELECT * FROM contract WHERE is_deleted = 0"; const ps = []; if (cust) { sql += " AND customer_id = ?"; ps.push(cust.id); } return db.rows(sql, ps); };
  const pay_sum = (cs) => cs.reduce((s, c) => s + parseInt(db.scalar("SELECT COALESCE(SUM(CAST(ROUND(amount*100) AS INTEGER)),0) FROM payment WHERE contract_id = ? AND is_deleted = 0", [c.id]) || 0, 10), 0);

  if (/转化率|转化情况|成单率/.test(text)) {
    const qs = db.rows("SELECT status FROM quotation WHERE is_deleted = 0");
    const converted = qs.filter(q => q.status === "已转合同").length;
    const denom = qs.filter(q => ["已发出", "已确认", "已转合同", "已失效"].includes(q.status)).length;
    return { metric: "报价转化率", value: denom === 0 ? "—" : (converted / denom * 100).toFixed(2), unit: "%", definition: "已转合同的报价单数 ÷ 已发出过的报价单数（分母排除草稿与已作废）", detail: `分子 ${converted} 份 ÷ 分母 ${denom} 份` };
  }
  if (/签约周期|签合同要多久|多久能签/.test(text)) {
    const cs = db.rows("SELECT c.created_at, q.created_at AS q_at FROM contract c JOIN quotation q ON q.id = c.source_quotation_id WHERE c.is_deleted = 0");
    const gaps = [];
    for (const c of cs) { try { const d1 = new Date(c.created_at.slice(0, 10)), d2 = new Date(c.q_at.slice(0, 10)); gaps.push(Math.round((d1 - d2) / 86400000)); } catch {} }
    return { metric: "平均签约周期", value: gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : "—", unit: "天", definition: "合同创建时间 − 来源报价单创建时间，仅统计有来源报价单的合同", detail: `样本 ${gaps.length} 份` };
  }
  if (text.includes("回款率")) {
    const cs = contracts();
    let tot = 0, paid = 0;
    for (const c of cs) { if (c.amount_type === "不适用") continue; tot += db.to_cents(c.amount); paid += parseInt(db.scalar("SELECT COALESCE(SUM(CAST(ROUND(amount*100) AS INTEGER)),0) FROM payment WHERE contract_id = ? AND is_deleted = 0", [c.id]) || 0, 10); }
    return { metric: "回款率", value: tot === 0 ? "—" : (paid / tot * 100).toFixed(2), unit: "%", definition: "已回款金额 ÷ 合同金额，金额口径为「不适用」的合同不计入分母", detail: `已回款 ${db.display_money(paid)} 元 ÷ 合同金额 ${db.display_money(tot)} 元` };
  }
  if (/还有多少钱?没回|还有钱没回|还有多少没回|还没回|未回款|没回的款|欠款|应收|还欠|回款情况/.test(text)) {
    const cs = contracts();
    let unpaid = 0, tot = 0, skip = 0;
    for (const c of cs) { if (c.amount_type === "不适用") { skip++; continue; } tot += db.to_cents(c.amount); unpaid += db.to_cents(c.amount) - parseInt(db.scalar("SELECT COALESCE(SUM(CAST(ROUND(amount*100) AS INTEGER)),0) FROM payment WHERE contract_id = ? AND is_deleted = 0", [c.id]) || 0, 10); }
    const scope = cust ? cust.name : "全部客户";
    return { metric: "未回款金额", value: db.display_money(unpaid), unit: "元", definition: "合同金额 − 已回款金额；金额口径为「不适用」的合同不适用", detail: `范围：${scope}，涉及 ${cs.length - skip} 份合同${skip ? `（另有 ${skip} 份金额口径为不适用，未计入）` : ""}` };
  }
  if (/回了多少|回款多少|收款多少|已回款|回款总额|到账多少|收了多少|回来多少钱/.test(text)) {
    let sql = "SELECT p.received_date, p.amount FROM payment p JOIN contract c ON c.id = p.contract_id WHERE p.is_deleted = 0";
    const ps = [];
    if (cust) { sql += " AND c.customer_id = ?"; ps.push(cust.id); }
    const data = db.rows(sql, ps);
    const sel = data.filter(p => _in_range(p.received_date, start, end));
    const total = sel.reduce((s, p) => s + db.to_cents(p.amount), 0);
    return { metric: "已回款金额", value: db.display_money(total), unit: "元", definition: "统计区间内到账的回款记录金额之和", detail: `区间：${label}，共 ${sel.length} 笔` };
  }
  if (/逾期|超期没回|拖欠|没按期/.test(text)) {
    const cs = contracts();
    const bad = cs.filter(c => proc.overdue_info(c.id)[0]);
    const names = bad.slice(0, 5).map(c => c.contract_no).join("、");
    return { metric: "逾期合同数", value: String(bad.length), unit: "份", definition: "存在约定回款日期已过、且该期未回款的付款期次的合同数", detail: bad.length ? `涉及：${names}…` : "无逾期合同", items: bad.slice(0, 50).map(c => ({ type: "contract", id: c.id, label: `${c.contract_no} ${c.name}` })) };
  }
  if (/卡住|停滞|没动|积压|停在那|卡在/.test(text)) {
    const items = proc.list_processes({ include_closed: false });
    const bad = items.filter(p => p.is_stagnant);
    const detail = bad.slice(0, 5).map(p => `${p.customer_name}（${p.current_stage} 停 ${p.stage_days} 天）`).join("；");
    return { metric: "停滞单数", value: String(bad.length), unit: "单", definition: "当前阶段停留天数超过阈值的在办业务数", detail: detail || "无停滞业务", items: bad.slice(0, 50).map(p => ({ type: p.contract_id ? "contract" : "quotation", id: p.contract_id || p.process_id, label: `${p.customer_name} · ${p.current_stage} 停 ${p.stage_days} 天` })) };
  }
  if (/在办|有多少单|进行中的业务|在建|在跑/.test(text)) {
    const items = proc.list_processes({ include_closed: false });
    return { metric: "在办业务数", value: String(items.length), unit: "单", definition: "业务进程中当前阶段不为「已完结」的业务数", detail: items.slice(0, 6).map(p => `${p.customer_name}·${p.current_stage}`).join("；"), items: items.slice(0, 50).map(p => ({ type: p.contract_id ? "contract" : "quotation", id: p.contract_id || p.process_id, label: `${p.customer_name} · ${p.current_stage}` })) };
  }
  if (/快到期|即将到期|快要到期|临近到期|要到期|到期提醒/.test(text)) {
    const limit = new Date(); limit.setDate(limit.getDate() + 90);
    const cs = contracts().filter(c => c.status === "履行中" && c.service_end_date >= db.today_str() && new Date(c.service_end_date) <= limit);
    cs.sort((a, b) => a.service_end_date.localeCompare(b.service_end_date));
    const detail = cs.slice(0, 6).map(c => `${c.contract_no}（${c.service_end_date}，还有 ${Math.round((new Date(c.service_end_date) - new Date()) / 86400000)} 天）`).join("；");
    return { metric: "90 天内到期合同", value: String(cs.length), unit: "份", definition: "状态为「履行中」且服务结束日期落在未来 90 天内的合同", detail: detail || "未来 90 天内没有到期的合同", items: cs.slice(0, 50).map(c => ({ type: "contract", id: c.id, label: `${c.contract_no} · ${c.service_end_date} 到期` })) };
  }
  if (/签了几|签了多少|签约数|新签|签订数|签了合同|成交了几|成了几单/.test(text)) {
    const cs = contracts().filter(c => !["草稿", "已作废"].includes(c.status) && _in_range(c.sign_date || c.created_at, start, end));
    const scope = cust ? cust.name : "全部客户";
    return { metric: "签约数", value: String(cs.length), unit: "份", definition: "统计区间内签署日期落在其间的合同数（未填签署日期的按创建时间计），排除草稿与已作废", detail: `区间：${label}，范围：${scope}`, items: cs.slice(0, 50).map(c => ({ type: "contract", id: c.id, label: `${c.contract_no} ${c.name}` })) };
  }
  if (/合同总(额|金额)|签了多少钱|合同金额合计|合同金额总计/.test(text)) {
    const cs = contracts().filter(c => c.amount_type !== "不适用" && _in_range(c.sign_date || c.created_at, start, end));
    const total = cs.reduce((s, c) => s + db.to_cents(c.amount), 0);
    const scope = cust ? cust.name : "全部客户";
    return { metric: "合同总金额", value: db.display_money(total), unit: "元", definition: "统计区间内合同金额之和，金额口径为「不适用」的合同不计入", detail: `区间：${label}，范围：${scope}，共 ${cs.length} 份` };
  }
  if (/开票|发票/.test(text) && /多少|金额|合计|统计|分别|哪些|几家|汇总|总额/.test(text)) {
    const inv = db.rows("SELECT i.*, c.contract_no, c.customer_id, cu.name AS customer_name FROM invoice i JOIN contract c ON c.id = i.contract_id JOIN customer cu ON cu.id = c.customer_id WHERE i.is_deleted = 0");
    const sel = inv.filter(i => _in_range(i.invoice_date, start, end) && (!cust || i.customer_id === cust.id));
    const total = sel.reduce((s, i) => s + db.to_cents(i.amount), 0);
    const by_cust = {};
    for (const i of sel) { const a = by_cust[i.customer_id] || (by_cust[i.customer_id] = { name: i.customer_name, cents: 0, n: 0 }); a.cents += db.to_cents(i.amount); a.n += 1; }
    const ranked = Object.entries(by_cust).sort((a, b) => b[1].cents - a[1].cents);
    return { metric: `${label}开票金额`, value: db.display_money(total), unit: "元", definition: `按开票日期落在区间内、且未删除的开票记录金额之和。范围：${label}${cust ? "，客户：" + cust.name : ""}`, detail: `共 ${sel.length} 张发票，涉及 ${ranked.length} 家客户：` + (ranked.slice(0, 6).map(([, a]) => `${a.name} ¥${db.display_money(a.cents)}（${a.n} 张）`).join("；") || "无"), items: ranked.slice(0, 50).map(([k, a]) => ({ type: "customer", id: k, label: `${a.name} · 开票 ¥${db.display_money(a.cents)}` })) };
  }
  if (/最大|最小|最高|最低|最多|最少|排名|排行|top/i.test(text)) {
    const want_min = /最小|最低|最少/.test(text);
    const by_customer = /客户|公司|甲方|买家/.test(text);
    const pool = contracts().filter(c => c.amount_type !== "不适用" && !["草稿", "已作废"].includes(c.status) && _in_range(c.sign_date || c.created_at, start, end));
    if (pool.length) {
      if (by_customer) {
        const agg = {};
        for (const c of pool) { const a = agg[c.customer_id] || (agg[c.customer_id] = { cents: 0, n: 0 }); a.cents += db.to_cents(c.amount); a.n += 1; }
        const name_of = {}; for (const r of db.rows("SELECT id, name FROM customer")) name_of[r.id] = r.name;
        let best_id, a; [best_id, a] = want_min ? Object.entries(agg).sort((x, y) => x[1].cents - y[1].cents)[0] : Object.entries(agg).sort((x, y) => y[1].cents - x[1].cents)[0];
        const cname = name_of[best_id] || "";
        return { metric: `合同总额${want_min ? "最低" : "最高"}的客户`, value: db.display_money(a.cents), unit: "元", definition: `按客户汇总其名下合同金额后取极值（排除草稿、已作废，以及金额口径为「不适用」的合同）。范围：${label}，共 ${Object.keys(agg).length} 家客户参与比较`, detail: `${cname}，共 ${a.n} 份合同`, items: [{ type: "customer", id: best_id, label: `${cname} · 合同额 ¥${db.display_money(a.cents)}（${a.n} 份）` }] };
      }
      const best = want_min ? pool.slice().sort((x, y) => db.to_cents(x.amount) - db.to_cents(y.amount))[0] : pool.slice().sort((x, y) => db.to_cents(y.amount) - db.to_cents(x.amount))[0];
      return { metric: `金额${want_min ? "最小" : "最大"}的合同`, value: db.display_money(db.to_cents(best.amount)), unit: "元", definition: `在区间内、状态不为草稿/已作废、且金额口径不是「不适用」的合同中取金额极值。范围：${label}，共 ${pool.length} 份参与比较`, detail: `${best.contract_no} ${best.name}`, items: [{ type: "contract", id: best.id, label: `${best.contract_no} ${best.name}（¥${db.display_money(db.to_cents(best.amount))}）` }] };
    }
  }
  if (cust && /合同|单子/.test(text) && /所有|全部|哪些|列出|看看|查看|几份|多少份|都有|清单/.test(text)) {
    const cs = contracts().slice().sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return { metric: `${cust.name}的合同`, value: String(cs.length), unit: "份", definition: `该客户名下全部合同（含草稿），按创建时间倒序。客户：${cust.name}`, detail: cs.slice(0, 8).map(c => `${c.contract_no}（${c.status}）`).join("；") || "该客户名下暂无合同", items: cs.slice(0, 50).map(c => ({ type: "contract", id: c.id, label: `${c.contract_no} ${c.name}（${c.status}）` })) };
  }
  return null;
}

export function format_reply(r) { return `${r.metric}：${r.value} ${r.unit}`; }
