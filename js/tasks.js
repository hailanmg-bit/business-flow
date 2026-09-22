// tasks.js — 内置调度任务（平移自 app/tasks.py，对应 PRD 3.3 / DRD 5.3、5.5）。
//
// 原则：**只处理客观时间事实**。全部为应用内置调度，不依赖任何外部系统。
// 与后端差异：用 db.* 直接操作 sql.js，无 conn 参数。
import * as db from "./db.js";
import * as proc from "./process.js";

const NOW = "date('now','localtime')";

/** 去重写入：同一对象 + 同一类型同时只保留一条未读（PRD 4.8.3）。 */
function _upsert(rtype, otype, oid, content) {
  const exist = db.one("SELECT id FROM reminder WHERE remind_type=? AND object_type=? AND object_id=? AND is_read=0",
    [rtype, otype, oid]);
  if (exist) {
    db.run("UPDATE reminder SET triggered_at=?, content=? WHERE id=?", [db.now_iso(), content, exist.id]);
    return 0;
  }
  db.run("INSERT INTO reminder(id,remind_type,object_type,object_id,content,triggered_at,is_read) VALUES(?,?,?,?,?,?,0)",
    [db.new_id(), rtype, otype, oid, content, db.now_iso()]);
  return 1;
}

/** 报价单超过有效期 → 已失效（仅「已发出」）。 */
export function quotation_expiry() {
  let n = 0;
  for (const q of db.rows(`SELECT * FROM quotation WHERE is_deleted=0 AND status='已发出' AND valid_until < ${NOW}`)) {
    db.run("UPDATE quotation SET status='已失效', updated_at=? WHERE id=?", [db.now_iso(), q.id]);
    db.run("INSERT INTO status_log(id,object_type,object_id,from_status,to_status,changed_at,source,remark) VALUES(?,?,?,?,?,?,?,?)",
      [db.new_id(), "QUOTATION", q.id, "已发出", "已失效", db.now_iso(), "系统自动", `超过有效期 ${q.valid_until}`]);
    n += 1;
  }
  return n;
}

/** 合同服务期结束 + 30 天 → 已到期 + 归档。 */
export function contract_expiry() {
  let n = 0;
  for (const c of db.rows(`SELECT * FROM contract WHERE is_deleted=0 AND status='履行中' AND date(service_end_date, '+30 days') < ${NOW}`)) {
    db.run("UPDATE contract SET status='已到期', is_archived=1, updated_at=? WHERE id=?", [db.now_iso(), c.id]);
    db.run("INSERT INTO status_log(id,object_type,object_id,from_status,to_status,changed_at,source,remark) VALUES(?,?,?,?,?,?,?,?)",
      [db.new_id(), "CONTRACT", c.id, "履行中", "已到期", db.now_iso(), "系统自动", `服务期 ${c.service_end_date} 结束满 30 天`]);
    n += 1;
  }
  return n;
}

/** 扫描并生成 8 类提醒。 */
export function reminder_scan() {
  let created = 0;
  const today = db.today_str();

  // ① 报价单有效期（到期前 3 天）
  for (const q of db.rows("SELECT q.*, u.name AS cn FROM quotation q JOIN customer u ON u.id=q.customer_id "
    + `WHERE q.is_deleted=0 AND q.status='已发出' AND q.valid_until BETWEEN ${NOW} AND date('now','localtime','+3 days')`)) {
    created += _upsert("报价有效期", "QUOTATION", q.id,
      `报价单 ${q.quotation_no}（${q.cn}）将于 ${q.valid_until} 到期`);
  }

  // ② 合同到期（30/15/7 天）
  for (const c of db.rows("SELECT c.*, u.name AS cn FROM contract c JOIN customer u ON u.id=c.customer_id "
    + `WHERE c.is_deleted=0 AND c.status='履行中' AND CAST(julianday(c.service_end_date) - julianday(${NOW}) AS INTEGER) IN (30,15,7)`)) {
    const d = Math.round((new Date(c.service_end_date) - new Date(today)) / 86400000);
    created += _upsert("合同到期", "CONTRACT", c.id, `${c.cn} 的合同（${c.contract_no}）还有 ${d} 天到期`);
  }

  // ③ 合同续签（自动续约，到期前 30 天）
  for (const c of db.rows("SELECT c.*, u.name AS cn FROM contract c JOIN customer u ON u.id=c.customer_id "
    + `WHERE c.is_deleted=0 AND c.status='履行中' AND c.auto_renewal=1 AND c.service_end_date = date('now','localtime','+30 days')`)) {
    created += _upsert("合同续签", "CONTRACT", c.id, `${c.cn} 的合同含自动续约条款，30 天后到期，请评估续签`);
  }

  // ④ 交付超期
  for (const c of db.rows("SELECT c.*, u.name AS cn FROM contract c JOIN customer u ON u.id=c.customer_id "
    + `WHERE c.is_deleted=0 AND c.status='履行中' AND c.planned_delivery_date IS NOT NULL AND c.planned_delivery_date < ${NOW} `
    + "AND NOT EXISTS (SELECT 1 FROM delivery d WHERE d.contract_id=c.id AND d.is_deleted=0)")) {
    created += _upsert("交付超期", "CONTRACT", c.id, `${c.cn} 的合同约定 ${c.planned_delivery_date} 交付，至今未录入交付记录`);
  }

  // ⑤ 验收超期（签收后 30 天未验收）
  for (const r of db.rows("SELECT c.id, c.contract_no, u.name AS cn, MAX(d.receipt_date) AS rd FROM contract c "
    + "JOIN customer u ON u.id=c.customer_id JOIN delivery d ON d.contract_id=c.id AND d.is_deleted=0 "
    + `WHERE c.is_deleted=0 AND c.status='履行中' AND d.receipt_date IS NOT NULL GROUP BY c.id HAVING date(MAX(d.receipt_date), '+30 days') < ${NOW} `
    + "AND NOT EXISTS (SELECT 1 FROM acceptance a WHERE a.contract_id=c.id AND a.is_deleted=0)")) {
    created += _upsert("验收超期", "CONTRACT", r.id, `${r.cn} 的合同已于 ${r.rd} 签收，超过 30 天未录入验收记录`);
  }

  // ⑥ 开票未开（验收通过后 30 天）
  for (const r of db.rows("SELECT c.id, u.name AS cn, MAX(a.accept_date) AS ad FROM contract c "
    + "JOIN customer u ON u.id=c.customer_id JOIN acceptance a ON a.contract_id=c.id AND a.is_deleted=0 AND a.result='通过' "
    + `WHERE c.is_deleted=0 AND c.status IN ('履行中','已到期') GROUP BY c.id HAVING date(MAX(a.accept_date), '+30 days') < ${NOW} `
    + "AND NOT EXISTS (SELECT 1 FROM invoice i WHERE i.contract_id=c.id AND i.is_deleted=0)")) {
    created += _upsert("开票未开", "CONTRACT", r.id, `${r.cn} 的合同已于 ${r.ad} 验收通过，超过 30 天未录入开票记录`);
  }

  // ⑦ 回款逾期
  for (const c of db.rows("SELECT c.id, c.contract_no, u.name AS cn FROM contract c JOIN customer u ON u.id=c.customer_id "
    + `WHERE c.is_deleted=0 AND c.status IN ('履行中','已到期') AND EXISTS (SELECT 1 FROM contract_payment_plan pp `
    + `WHERE pp.contract_id=c.id AND pp.is_deleted=0 AND pp.due_date < ${NOW})`)) {
    const alloc = db.allocate_payments(c.id);
    const overdue = (alloc.plans || []).filter(p => p.status === "逾期");
    if (overdue.length) {
      const p = overdue[0];
      created += _upsert("回款逾期", "CONTRACT", c.id,
        `${c.cn} 的合同第 ${p.seq_no} 期约定 ${p.due_date} 回款 ${p.plan_amount} 元，至今未到账`);
    }
  }

  // ⑧ 进程停滞
  for (const p of proc.list_processes({ include_closed: false })) {
    if (p.is_stagnant && p.contract_id) {
      const next = (p.next_actions && p.next_actions[0]) || "跟进";
      created += _upsert("进程停滞", "CONTRACT", p.contract_id,
        `${p.customer_name} 的业务在「${p.current_stage}」阶段停留 ${p.stage_days} 天未推进，建议：${next}`);
    }
  }
  return { created };
}

/** 对象进入终态后，清理其未读提醒。 */
export function reminder_expire() {
  const before = db.scalar("SELECT COUNT(*) FROM reminder WHERE is_read=0 AND ("
    + "  (object_type='CONTRACT'  AND EXISTS (SELECT 1 FROM contract  x WHERE x.id=reminder.object_id AND x.status IN ('已终止','已作废'))) OR"
    + "  (object_type='QUOTATION' AND EXISTS (SELECT 1 FROM quotation x WHERE x.id=reminder.object_id AND x.status IN ('已转合同','已失效','已作废')))"
    + ")");
  db.run("UPDATE reminder SET is_read=1, read_at=? WHERE is_read=0 AND ("
    + "  (object_type='CONTRACT'  AND EXISTS (SELECT 1 FROM contract  x WHERE x.id=reminder.object_id AND x.status IN ('已终止','已作废'))) OR"
    + "  (object_type='QUOTATION' AND EXISTS (SELECT 1 FROM quotation x WHERE x.id=reminder.object_id AND x.status IN ('已转合同','已失效','已作废')))"
    + ")", [db.now_iso()]);
  return before;
}

export function run_all() {
  const snap = proc.refresh_snapshot();
  return {
    quotation_expiry: quotation_expiry(),
    contract_expiry: contract_expiry(),
    reminder_expire: reminder_expire(),
    reminder_scan: reminder_scan(),
    process_snapshot: snap,
  };
}
