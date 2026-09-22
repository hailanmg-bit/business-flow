// seed.js — 素材库播种（平移自 app/seed.py）。
//
// 合同正文参照《技术服务合同》示范文本（科学技术部印制）与常见商务合同条款结构编写，
// 分「服务内容 / 服务期限 / 报酬与支付 / 验收 / 保密 / 成果归属 / 违约责任 / 争议解决」八条。
// 数据刻意覆盖全部 8 类提醒与全部状态，便于体验测试。
//
// 素材本体在 seed_data.js（由 seed.py 经 AST 精确转换生成），本文件只负责落库。
import * as db from "./db.js";
import * as tasks from "./tasks.js";
import { OUR, CUSTOMERS, TEMPLATES, CONTRACTS, QUOTATIONS } from "./seed_data.js";

export { OUR };

/** 按示范文本条款结构生成合同正文（富文本）。 */
export function contract_body(name, customer, amount, start, end, plan_text, breach = "0.05", items = null, accept_days = 30) {
  let item_rows = "";
  if (items && items.length) {
    item_rows = items.map(i =>
      `<tr><td>${i.name}</td><td>${i.spec || "—"}</td><td>${i.quantity}</td><td>${i.unit_price}</td><td>${i.amount}</td></tr>`
    ).join("");
  }
  const item_table = item_rows
    ? "<table border='1' cellspacing='0' cellpadding='6'><tr><th>服务项目</th><th>规格说明</th><th>数量</th><th>单价(元)</th><th>金额(元)</th></tr>" + item_rows + "</table>"
    : "";
  return `<h3>${name}</h3>
<p><b>委托方（甲方）：</b>${customer}<br/><b>受托方（乙方）：</b>${OUR}</p>

<p><b>第一条 服务内容</b><br/>
1.1 服务目标：由乙方向甲方提供本合同约定范围内的技术服务，并交付符合验收标准的服务成果。<br/>
1.2 服务内容：${name}项下全部工作，包括需求调研、方案设计、实施部署、培训交底与交付文档编制。<br/>
1.3 服务方式：以现场服务与远程支持相结合的方式开展。</p>

<p><b>第二条 服务期限</b><br/>
2.1 服务期限：自 ${start} 起至 ${end} 止。<br/>
2.2 服务地点：甲方指定场所。<br/>
2.3 服务质量要求：符合国家及行业相关技术标准与规范要求。</p>

<p><b>第三条 服务报酬及支付方式</b><br/>
3.1 本合同服务报酬总额为人民币 ${amount} 元（含税）。<br/>
3.2 支付方式：${plan_text}<br/>
3.3 甲方凭乙方开具的符合国家规定的发票支付相应款项。</p>

${item_table}

<p><b>第四条 验收</b><br/>
4.1 乙方完成服务后应书面通知甲方验收。<br/>
4.2 甲方应在收到验收通知后 ${accept_days} 日内按约定标准完成验收并出具验收证明；逾期未验收亦未提出书面异议的，视为验收合格。<br/>
4.3 验收标准以本合同第一条、第二条约定为准。</p>

<p><b>第五条 保密</b><br/>
5.1 双方对在合同签订及履行过程中知悉的对方商业秘密、技术资料、客户信息等负有保密义务，未经书面许可不得向第三方披露。<br/>
5.2 本保密条款在本合同终止或解除后 3 年内持续有效。</p>

<p><b>第六条 成果权利归属</b><br/>
6.1 乙方为履行本合同所完成的服务成果，其知识产权归甲方所有。<br/>
6.2 乙方保证其提供的服务及成果不侵犯任何第三方的合法权益；如发生侵权指控，由乙方负责解决并赔偿甲方由此产生的全部损失。</p>

<p><b>第七条 违约责任</b><br/>
7.1 任何一方未履行或未完全履行本合同项下义务的，均构成违约，违约方应赔偿守约方由此遭受的损失。<br/>
7.2 乙方逾期完成服务工作的，每逾期一日应按服务报酬总额的 0.05% 向甲方支付违约金。<br/>
7.3 甲方逾期支付报酬的，每逾期一日应按应付未付款项的 0.05% 向乙方支付违约金。<br/>
7.4 任何一方违约的，应按服务报酬总额的 ${breach}（${Math.round(parseFloat(breach) * 100)}%）向对方支付违约金；违约金不足以弥补实际损失的，应就差额部分予以赔偿。</p>

<p><b>第八条 争议解决</b><br/>
8.1 本合同适用中华人民共和国法律。<br/>
8.2 因本合同引起的争议，双方应友好协商解决；协商不成的，向乙方所在地有管辖权的人民法院起诉。<br/>
8.3 本合同自双方签字盖章之日起生效，一式两份，双方各执一份。</p>`;
}

/** 相对天数 → 日期：正数表示未来，负数表示过去（对应 seed.py 的 days_ago(-n)/days_ahead(n)）。 */
function relDay(n) { return n >= 0 ? db.days_ahead(n) : db.days_ago(-n); }

function fmtItemQty(qty, up) { return db.fmt_money(Math.trunc(parseFloat(qty) * db.to_cents(up))); }

/** 清空全部业务表（对应 seed.py reset）。 */
export function clearAllTables() {
  const tables = ["chat_message", "chat_conversation", "pending_action", "operation_log", "status_log", "reminder",
    "payment", "invoice", "acceptance", "delivery", "attachment", "contract_version",
    "contract_payment_plan", "contract_item", "contract", "contract_template_version",
    "contract_template", "quotation_version", "quotation_item", "quotation", "customer",
    "operator", "seq_counter", "process_snapshot"];
  for (const t of tables) db.run(`DELETE FROM ${t}`);
}

export function seedDatabase() {
  clearAllTables();
  const now = db.now_iso();

  // ---- 操作人 ----
  const ops = [];
  for (const nm of ["浩然", "李婷"]) {
    const oid = db.new_id();
    db.run("INSERT INTO operator(id,name,is_active,created_at,is_deleted) VALUES(?,?,1,?,0)", [oid, nm, now]);
    ops.push(oid);
  }
  db.set_setting("current_operator_id", ops[0]);

  // ---- 客户 ----
  const cust_ids = [];
  for (const c of CUSTOMERS) {
    const cid = db.new_id();
    db.run("INSERT INTO customer(id,name,credit_code,contact_name,contact_phone,address,invoice_title,invoice_tax_no,invoice_bank,invoice_account,owner_id,created_at,created_by,updated_at,updated_by,is_deleted) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
      [cid, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], ops[0], now, ops[0], now, ops[0]]);
    cust_ids.push(cid);
  }

  // ---- 合同模板 ----
  const tpl_ids = [];
  for (const [name, ttype, content] of TEMPLATES) {
    const tid = db.new_id();
    const vars = JSON.stringify(Array.from(new Set((content.match(/\{\{(.+?)\}\}/g) || []).map(s => s.slice(2, -2)))).sort());
    db.run("INSERT INTO contract_template(id,name,template_type,status,current_version_no,variables,source_note,created_at,created_by,updated_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
      [tid, name, ttype, "启用", "V1.0", vars, "条款结构参照《技术服务合同》示范文本（科学技术部印制）", now, ops[0], now]);
    db.run("INSERT INTO contract_template_version(id,template_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [db.new_id(), tid, "V1.0", content, "初始版本", ops[0], now]);
    tpl_ids.push(tid);
  }

  // ---- 报价单 ----
  const q_ids = [];
  db.run("DELETE FROM seq_counter WHERE prefix='BJ'");
  for (const [ci, cons_i, status, amount, valid_d, created_d, owner_i, items, terms] of QUOTATIONS) {
    const qid = db.new_id();
    const day = created_d === 0 ? db.today_str() : db.days_ago(-created_d);
    const no = db.next_no("BJ", day);
    db.run("INSERT INTO quotation(id,quotation_no,customer_id,amount,currency,valid_until,payment_terms,status,owner_id,current_version_no,created_at,created_by,updated_at,updated_by,is_deleted) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
      [qid, no, cust_ids[ci], amount, "CNY", db.days_ahead(valid_d), terms, status, ops[owner_i],
        "V1.0", day + "T09:30:00", ops[owner_i], day + "T09:30:00", ops[owner_i]]);
    const snap = [];
    items.forEach((it, i) => {
      const amt = fmtItemQty(it[2], it[3]);
      db.run("INSERT INTO quotation_item(id,quotation_id,name,spec,quantity,unit_price,amount,sort_no,is_deleted) VALUES(?,?,?,?,?,?,?,?,0)",
        [db.new_id(), qid, it[0], it[1], it[2], it[3], amt, i]);
      snap.push({ name: it[0], spec: it[1], quantity: it[2], unit_price: it[3], amount: amt });
    });
    db.run("INSERT INTO quotation_version(id,quotation_id,version_no,amount,items_snapshot,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
      [db.new_id(), qid, "V1.0", amount, JSON.stringify(snap), "初始版本", ops[owner_i], day + "T09:30:00"]);
    if (["已发出", "已确认", "已转合同", "已失效"].includes(status)) {
      const seq = status === "已转合同" ? ["已发出", "已确认", "已转合同"] : [status];
      for (const st of seq) {
        db.run("INSERT INTO status_log(id,object_type,object_id,from_status,to_status,changed_by,changed_at,source,remark) VALUES(?,?,?,?,?,?,?,?,?)",
          [db.new_id(), "QUOTATION", qid, "草稿", st, ops[owner_i], day + "T14:00:00", "手动", ""]);
      }
    }
    q_ids.push(qid);
  }

  // ---- 合同 ----
  const c_ids = [];
  db.run("DELETE FROM seq_counter WHERE prefix='HT'");
  for (const cfg of CONTRACTS) {
    const cid = db.new_id();
    const s_d = relDay(cfg.s[0]), e_d = relDay(cfg.s[1]);
    const day = relDay(cfg.created);
    const no = db.next_no("HT", day);
    const src_q = cfg.qi !== null ? q_ids[cfg.qi] : null;
    const cust = CUSTOMERS[cfg.ci][0];
    const items = cfg.items.map(a => ({
      name: a[0], spec: a[1], quantity: a[2], unit_price: a[3], amount: fmtItemQty(a[2], a[3]),
    }));
    const plan_text = cfg.plans.map(([n, amt, d]) => `第 ${n} 期 ${amt} 元（约定 ${db.days_ahead(d)} 前支付）`).join("；");
    const body = contract_body(cfg.name, cust, cfg.amount, s_d, e_d, plan_text, "0.05", items);
    db.run("INSERT INTO contract(id,contract_no,name,contract_type,customer_id,amount,amount_type,currency,service_start_date,service_end_date,sign_date,planned_delivery_date,auto_renewal,source_quotation_id,payment_terms,status,owner_id,current_version_no,is_archived,created_at,created_by,updated_at,updated_by,is_deleted) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
      [cid, no, cfg.name, cfg.ctype, cust_ids[cfg.ci], cfg.amount, "合同总额", "CNY", s_d, e_d,
        cfg.sign !== null ? relDay(cfg.sign) : null, cfg.deliver !== null ? relDay(cfg.deliver) : null, cfg.renewal,
        src_q, plan_text, cfg.status, ops[cfg.owner], "V1.0",
        (cfg.status === "已到期" || cfg.status === "已终止") ? 1 : 0,
        day + "T10:00:00", ops[cfg.owner], day + "T10:00:00", ops[cfg.owner]]);
    items.forEach((it, i) => db.run("INSERT INTO contract_item(id,contract_id,name,spec,quantity,unit_price,amount,sort_no,is_deleted) VALUES(?,?,?,?,?,?,?,?,0)",
      [db.new_id(), cid, it.name, it.spec, it.quantity, it.unit_price, it.amount, i]));
    cfg.plans.forEach(([n, amt, d]) => db.run("INSERT INTO contract_payment_plan(id,contract_id,seq_no,plan_amount,due_date,created_at,is_deleted) VALUES(?,?,?,?,?,?,0)",
      [db.new_id(), cid, n, amt, db.days_ahead(d), day + "T10:05:00"]));
    db.run("INSERT INTO contract_version(id,contract_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [db.new_id(), cid, "V1.0", body, "初始版本", ops[cfg.owner], day + "T10:10:00"]);
    const flow = { "草稿": [], "待签署": ["待签署"], "履行中": ["待签署", "履行中"],
      "已到期": ["待签署", "履行中", "已到期"] }[cfg.status] || [];
    const prevMap = { "待签署": "草稿", "履行中": "待签署", "已到期": "履行中" };
    for (const st of flow) {
      db.run("INSERT INTO status_log(id,object_type,object_id,from_status,to_status,changed_by,changed_at,source,remark) VALUES(?,?,?,?,?,?,?,?,?)",
        [db.new_id(), "CONTRACT", cid, prevMap[st], st, ops[cfg.owner],
          (cfg.sign !== null ? relDay(cfg.sign) : day) + "T15:00:00", "手动", `推进为${st}`]);
    }
    for (const [kind, payload] of cfg.fulfil) {
      const rid = db.new_id();
      const cols = ["id", "contract_id", ...Object.keys(payload), "created_at", "created_by", "updated_at", "is_deleted"];
      const vals = [rid, cid, ...Object.values(payload), now, ops[cfg.owner], now, 0];
      db.run(`INSERT INTO ${kind}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, vals);
    }
    c_ids.push(cid);
  }

  // ---- 内置调度：生成提醒 / 刷新进程快照（对应 seed.py 结尾的 tasks.run_all）----
  let taskStat = {};
  try { taskStat = tasks.run_all(); } catch (e) { console.error("[seed] 调度任务失败", e); }
  const reminders = db.scalar("SELECT COUNT(*) FROM reminder");

  return {
    customers: cust_ids.length, quotations: q_ids.length, contracts: c_ids.length,
    templates: tpl_ids.length, operators: ops.length, reminders, tasks: taskStat,
  };
}
