// db.js — 数据访问层（sql.js 在浏览器跑 SQLite + IndexedDB 持久化）
// 平移自后端 db.py。金额全程整数分运算，不碰浮点。
let SQL = null;
let _db = null;
let _saveTimer = null;
const IDB_NAME = "bizflow_db";
const IDB_STORE = "dbfile";
const IDB_KEY = "business_flow";

// ---------------- 建库语句（来自 schema.sql，去掉 journal_mode WAL） ----------------
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operator (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS uk_operator_name ON operator (lower(name)) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS app_setting (
  setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS seq_counter (
  prefix TEXT NOT NULL, biz_date TEXT NOT NULL, current_no INTEGER NOT NULL,
  PRIMARY KEY (prefix, biz_date));

CREATE TABLE IF NOT EXISTS customer (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, credit_code TEXT, contact_name TEXT, contact_phone TEXT,
  address TEXT, invoice_title TEXT, invoice_tax_no TEXT, invoice_bank TEXT, invoice_account TEXT,
  owner_id TEXT, remark TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL,
  updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS uk_customer_name ON customer (lower(name)) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_customer_owner ON customer (owner_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS quotation (
  id TEXT PRIMARY KEY, quotation_no TEXT NOT NULL, customer_id TEXT NOT NULL, amount TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY', valid_until TEXT NOT NULL, payment_terms TEXT,
  status TEXT NOT NULL DEFAULT '草稿' CHECK (status IN ('草稿','已发出','已确认','已转合同','已失效','已作废')),
  owner_id TEXT, current_version_no TEXT NOT NULL DEFAULT 'V1.0', remark TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS uk_quotation_no ON quotation (quotation_no);
CREATE INDEX IF NOT EXISTS idx_quotation_customer ON quotation (customer_id) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_quotation_valid ON quotation (status, valid_until) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS quotation_version (
  id TEXT PRIMARY KEY, quotation_id TEXT NOT NULL, version_no TEXT NOT NULL, amount TEXT NOT NULL,
  items_snapshot TEXT NOT NULL DEFAULT '[]', change_summary TEXT, created_by TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uk_quotation_version ON quotation_version (quotation_id, version_no);

CREATE TABLE IF NOT EXISTS quotation_item (
  id TEXT PRIMARY KEY, quotation_id TEXT NOT NULL, name TEXT NOT NULL, spec TEXT,
  quantity TEXT NOT NULL DEFAULT '1', unit_price TEXT NOT NULL, amount TEXT NOT NULL,
  sort_no INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_quotation_item ON quotation_item (quotation_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS contract_template (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, template_type TEXT NOT NULL
    CHECK (template_type IN ('报价单','销售合同','服务合同','保密协议','其他')),
  status TEXT NOT NULL DEFAULT '草稿' CHECK (status IN ('草稿','启用','停用')),
  current_version_no TEXT NOT NULL DEFAULT 'V1.0', variables TEXT NOT NULL DEFAULT '[]',
  source_note TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS contract_template_version (
  id TEXT PRIMARY KEY, template_id TEXT NOT NULL, version_no TEXT NOT NULL, content TEXT NOT NULL,
  change_summary TEXT, created_by TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uk_template_version ON contract_template_version (template_id, version_no);

CREATE TABLE IF NOT EXISTS contract (
  id TEXT PRIMARY KEY, contract_no TEXT NOT NULL, name TEXT NOT NULL, contract_type TEXT NOT NULL
    CHECK (contract_type IN ('销售合同','服务合同','框架合同','其他')),
  customer_id TEXT NOT NULL, amount TEXT, amount_type TEXT NOT NULL DEFAULT '合同总额'
    CHECK (amount_type IN ('合同总额','框架上限','不适用')),
  currency TEXT NOT NULL DEFAULT 'CNY', service_start_date TEXT NOT NULL, service_end_date TEXT NOT NULL,
  sign_date TEXT, planned_delivery_date TEXT, auto_renewal INTEGER NOT NULL DEFAULT 0,
  source_quotation_id TEXT, template_id TEXT, payment_terms TEXT,
  status TEXT NOT NULL DEFAULT '草稿' CHECK (status IN ('草稿','待签署','履行中','已到期','已终止','已作废')),
  owner_id TEXT, current_version_no TEXT NOT NULL DEFAULT 'V1.0', is_archived INTEGER NOT NULL DEFAULT 0,
  remark TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS uk_contract_no ON contract (contract_no);
CREATE INDEX IF NOT EXISTS idx_contract_customer ON contract (customer_id) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_contract_status ON contract (status, service_end_date, is_archived) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_contract_owner ON contract (owner_id) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_contract_source_q ON contract (source_quotation_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS contract_item (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, name TEXT NOT NULL, spec TEXT,
  quantity TEXT NOT NULL DEFAULT '1', unit_price TEXT NOT NULL, amount TEXT NOT NULL,
  sort_no INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_contract_item ON contract_item (contract_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS contract_payment_plan (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, seq_no INTEGER NOT NULL, plan_amount TEXT NOT NULL,
  due_date TEXT NOT NULL, remark TEXT, created_at TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS uk_payment_plan_seq ON contract_payment_plan (contract_id, seq_no) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_payment_plan_due ON contract_payment_plan (due_date) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS contract_version (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, version_no TEXT NOT NULL, content TEXT NOT NULL,
  change_summary TEXT, created_by TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uk_contract_version ON contract_version (contract_id, version_no);

CREATE TABLE IF NOT EXISTS attachment (
  id TEXT PRIMARY KEY, object_type TEXT NOT NULL CHECK (object_type IN ('CONTRACT','QUOTATION')),
  object_id TEXT NOT NULL, file_name TEXT NOT NULL, file_type TEXT NOT NULL, file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0, doc_kind TEXT NOT NULL DEFAULT '其他'
    CHECK (doc_kind IN ('合同正本','盖章扫描件','报价单回签','其他')),
  join_ai_qa INTEGER NOT NULL DEFAULT 0, uploaded_by TEXT, uploaded_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_attachment_object ON attachment (object_type, object_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS delivery (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, content TEXT NOT NULL, quantity TEXT,
  ship_date TEXT NOT NULL, logistics_no TEXT, receipt_status TEXT NOT NULL CHECK (receipt_status IN ('待签收','已签收','异常')),
  receipt_date TEXT, remark TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_delivery_contract ON delivery (contract_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS acceptance (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, accept_date TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('待验收','通过','不通过')), remark TEXT,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_acceptance_contract ON acceptance (contract_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS invoice (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, invoice_no TEXT NOT NULL, invoice_date TEXT NOT NULL,
  amount TEXT NOT NULL, receipt_status TEXT NOT NULL DEFAULT '待签收' CHECK (receipt_status IN ('待签收','已签收')),
  remark TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_invoice_contract ON invoice (contract_id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS payment (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, received_date TEXT NOT NULL, amount TEXT NOT NULL,
  serial_no TEXT, payment_plan_id TEXT, remark TEXT, created_at TEXT NOT NULL, created_by TEXT,
  updated_at TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_payment_contract ON payment (contract_id, received_date) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS reminder (
  id TEXT PRIMARY KEY, remind_type TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL,
  content TEXT NOT NULL, triggered_at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, read_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS uk_reminder_active ON reminder (remind_type, object_type, object_id) WHERE is_read = 0;
CREATE INDEX IF NOT EXISTS idx_reminder_list ON reminder (is_read, triggered_at DESC);

CREATE TABLE IF NOT EXISTS status_log (
  id TEXT PRIMARY KEY, object_type TEXT NOT NULL, object_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  changed_by TEXT, changed_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT '手动' CHECK (source IN ('手动','系统自动','自然语言')),
  remark TEXT);
CREATE INDEX IF NOT EXISTS idx_status_log_object ON status_log (object_type, object_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS operation_log (
  id TEXT PRIMARY KEY, operator_id TEXT, source TEXT NOT NULL CHECK (source IN ('手动','自然语言','系统自动')),
  action TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT, object_label TEXT, before_value TEXT,
  after_value TEXT, reversible INTEGER NOT NULL DEFAULT 0, reverted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_operation_log_time ON operation_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_log_object ON operation_log (object_type, object_id);

CREATE TABLE IF NOT EXISTS chat_conversation (
  id TEXT PRIMARY KEY, title TEXT, context TEXT, entity_stack TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_message (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_message ON chat_message (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS pending_action (
  id TEXT PRIMARY KEY, conversation_id TEXT, action_type TEXT NOT NULL, level INTEGER NOT NULL, plan TEXT NOT NULL,
  card TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pending_action ON pending_action (status, created_at DESC);

CREATE TABLE IF NOT EXISTS process_snapshot (
  process_type TEXT NOT NULL, process_id TEXT NOT NULL, customer_id TEXT, customer_name TEXT, contract_id TEXT,
  contract_no TEXT, contract_name TEXT, quotation_id TEXT, owner_id TEXT, owner_name TEXT, amount TEXT,
  amount_type TEXT, paid_amount TEXT, unpaid_amount TEXT, current_stage TEXT, stage_days INTEGER,
  is_stagnant INTEGER, is_archived INTEGER, planned_delivery_date TEXT, service_end_date TEXT, refreshed_at TEXT,
  PRIMARY KEY (process_type, process_id));
CREATE INDEX IF NOT EXISTS idx_snapshot_stage ON process_snapshot (current_stage, is_stagnant);

CREATE VIEW IF NOT EXISTS v_contract_amount AS
SELECT
  c.id AS contract_id, c.contract_no AS contract_no, c.customer_id AS customer_id, u.name AS customer_name,
  c.amount_type AS amount_type,
  CASE WHEN c.amount_type = '不适用' THEN NULL ELSE c.amount END AS contract_amount,
  COALESCE((SELECT SUM(CAST(ROUND(i.amount*100) AS INTEGER))/100.0 FROM invoice i
            WHERE i.contract_id = c.id AND i.is_deleted = 0), 0) AS invoice_amount,
  COALESCE((SELECT SUM(CAST(ROUND(p.amount*100) AS INTEGER))/100.0 FROM payment p
            WHERE p.contract_id = c.id AND p.is_deleted = 0), 0) AS paid_amount,
  CASE WHEN c.amount_type = '不适用' THEN NULL
       ELSE CAST(ROUND(c.amount*100) AS INTEGER)/100.0
            - COALESCE((SELECT SUM(CAST(ROUND(p.amount*100) AS INTEGER))/100.0 FROM payment p
                        WHERE p.contract_id = c.id AND p.is_deleted = 0), 0)
  END AS unpaid_amount,
  CASE WHEN c.amount_type = '不适用' OR CAST(ROUND(c.amount*100) AS INTEGER) = 0 THEN NULL
       ELSE ROUND(COALESCE((SELECT SUM(CAST(ROUND(p.amount*100) AS INTEGER)) FROM payment p
                            WHERE p.contract_id = c.id AND p.is_deleted = 0), 0)
                  * 100.0 / CAST(ROUND(c.amount*100) AS INTEGER), 2)
  END AS paid_rate
FROM contract c JOIN customer u ON u.id = c.customer_id WHERE c.is_deleted = 0;

CREATE VIEW IF NOT EXISTS v_business_process AS SELECT * FROM process_snapshot;
`;

// ---------------- 工具函数 ----------------
function pad(n) { return String(n).padStart(2, "0"); }
function pad3(n) { return String(n).padStart(3, "0"); }

export function new_id() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
  return "id" + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}

export function now_iso() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 19);
}

export function today_str() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function days_ago(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function days_ahead(n) { return days_ago(-n); }

export function fmt_money(cents) {
  const sign = cents < 0 ? "-" : "";
  cents = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(cents / 100)}.${pad(cents % 100)}`;
}

export function display_money(cents) {
  const sign = cents < 0 ? "-" : "";
  cents = Math.abs(Math.trunc(cents));
  const int = Math.floor(cents / 100);
  return `${sign}${int.toLocaleString("en-US")}.${pad(cents % 100)}`;
}

export function to_cents(value) {
  if (value === null || value === undefined || value === "") return 0;
  let s = String(value).trim().replace(/,/g, "").replace(/[¥￥]/g, "").replace(/元/g, "").trim();
  const neg = s.startsWith("-");
  s = s.replace(/^[+-]/, "");
  if (!s) return 0;
  let whole, frac;
  if (s.includes(".")) [whole, frac] = s.split(".", 2);
  else [whole, frac] = [s, ""];
  whole = (whole.replace(/\D/g, "") || "0");
  frac = (frac.replace(/\D/g, ""));
  const frac3 = (frac + "000").slice(0, 3);
  let cents = parseInt(whole, 10) * 100 + parseInt(frac3.slice(0, 2) || "0", 10);
  if (parseInt(frac3[2], 10) >= 5) cents += 1;
  return neg ? -cents : cents;
}

// ---------------- 查询封装 ----------------
export function getDB() { return _db; }

function _exec(sql, params) { return _db.exec(sql, params); }

export function rows(sql, params = []) {
  const res = _exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}
export function one(sql, params = []) {
  const r = rows(sql, params);
  return r.length ? r[0] : null;
}
export function scalar(sql, params = []) {
  const res = _exec(sql, params);
  if (!res.length || !res[0].values.length) return null;
  return res[0].values[0][0];
}

export function run(sql, params = []) {
  _db.run(sql, params);
  scheduleSave();
}
export function execScript(sql) { _db.exec(sql); scheduleSave(); }

// ---------------- 编号 / 设置 ----------------
export function next_no(prefix, day) {
  day = day || today_str();
  const compact = day.replace(/-/g, "");
  run("INSERT INTO seq_counter(prefix, biz_date, current_no) VALUES(?,?,1) "
    + "ON CONFLICT(prefix, biz_date) DO UPDATE SET current_no = current_no + 1", [prefix, day]);
  const no = scalar("SELECT current_no FROM seq_counter WHERE prefix = ? AND biz_date = ?", [prefix, day]);
  return `${prefix}-${compact}-${pad3(parseInt(no, 10))}`;
}

export function get_setting(key, def = null) {
  const r = one("SELECT setting_value FROM app_setting WHERE setting_key = ?", [key]);
  if (!r) return def;
  try { return JSON.parse(r.setting_value); }
  catch { return r.setting_value; }
}

export function set_setting(key, value) {
  run("INSERT INTO app_setting(setting_key, setting_value, updated_at) VALUES(?,?,?) "
    + "ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at",
    [key, JSON.stringify(value), now_iso()]);
}

export function current_operator_id() {
  const oid = get_setting("current_operator_id");
  if (oid) {
    const r = one("SELECT id FROM operator WHERE id = ? AND is_deleted = 0", [oid]);
    if (r) return oid;
  }
  const r = one("SELECT id FROM operator WHERE is_deleted = 0 ORDER BY created_at LIMIT 1");
  return r ? r.id : null;
}

// ---------------- 金额口径 / 付款核销 ----------------
const _CENTS = "SUM(CAST(ROUND(COALESCE({col},0)*100) AS INTEGER))";

export function amount_summary(contract_id) {
  const c = one("SELECT amount, amount_type FROM contract WHERE id = ?", [contract_id]);
  if (!c) return {};
  const na = c.amount_type === "不适用";
  const contract_cents = na ? 0 : to_cents(c.amount);
  const paid_cents = parseInt(scalar(
    `SELECT COALESCE(${_CENTS.replace("{col}", "amount")},0) FROM payment WHERE contract_id=? AND is_deleted=0`,
    [contract_id]) || 0, 10);
  const invoice_cents = parseInt(scalar(
    `SELECT COALESCE(${_CENTS.replace("{col}", "amount")},0) FROM invoice WHERE contract_id=? AND is_deleted=0`,
    [contract_id]) || 0, 10);
  if (na) {
    return { contract_amount: null, invoice_amount: fmt_money(invoice_cents),
      paid_amount: fmt_money(paid_cents), unpaid_amount: null, paid_rate: null };
  }
  const unpaid = contract_cents - paid_cents;
  const rate = contract_cents === 0 ? null : Math.round(paid_cents / contract_cents * 100 * 100) / 100;
  return { contract_amount: fmt_money(contract_cents), invoice_amount: fmt_money(invoice_cents),
    paid_amount: fmt_money(paid_cents), unpaid_amount: fmt_money(unpaid),
    paid_rate: rate === null ? null : rate.toFixed(2) };
}

export function allocate_payments(contract_id) {
  const plans = rows("SELECT id, seq_no, plan_amount, due_date FROM contract_payment_plan "
    + "WHERE contract_id=? AND is_deleted=0 ORDER BY seq_no", [contract_id]);
  const pays = rows("SELECT id, amount, payment_plan_id FROM payment WHERE contract_id=? AND is_deleted=0", [contract_id]);
  const total_paid = pays.reduce((s, p) => s + to_cents(p.amount), 0);
  const allocated = {};
  plans.forEach(p => allocated[p.id] = 0);
  let direct = 0;
  pays.forEach(p => {
    const pid = p.payment_plan_id;
    if (pid && allocated[pid] !== undefined) { allocated[pid] += to_cents(p.amount); direct += to_cents(p.amount); }
  });
  let pool = total_paid - direct;
  const today = today_str();
  const result = [];
  plans.forEach(plan => {
    const need = to_cents(plan.plan_amount) - allocated[plan.id];
    const take = Math.max(0, Math.min(pool, need));
    pool -= take;
    const got = allocated[plan.id] + take;
    const target = to_cents(plan.plan_amount);
    let st;
    if (got >= target && target > 0) st = "已回款";
    else if (got > 0) st = "部分回款";
    else if (plan.due_date < today) st = "逾期";
    else st = "未到期";
    result.push({ id: plan.id, seq_no: plan.seq_no, plan_amount: fmt_money(target),
      due_date: plan.due_date, allocated_amount: fmt_money(got), status: st });
  });
  return { plans: result, has_overpayment: pool > 0, overpayment: pool > 0 ? fmt_money(pool) : null };
}

// ---------------- 初始化 / 持久化 ----------------
const DEFAULT_SETTINGS = {
  current_operator_id: null,
  stagnation_threshold: { signing_days: 15, acceptance_days: 30, invoice_days: 30, delivery_overdue: true },
  ai_enabled: true, ai_contract_qa_enabled: true, ai_notice_accepted_at: null,
};

export function defaultSettings() { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }

export async function initDatabase() {
  if (_db) return _db;
  // 浏览器：用 locateFile 让 sql.js 去 ./vendor/ 取 wasm；
  // Node（仅用于自动化测试）：直接读本地 wasm 二进制，避免相对路径/网络解析问题。
  let SQL;
  if (typeof window === "undefined" && typeof process !== "undefined" && process.versions && process.versions.node) {
    const { readFileSync } = await import("fs");
    const { fileURLToPath } = await import("url");
    const wasmPath = fileURLToPath(new URL("./../vendor/sql-wasm.wasm", import.meta.url));
    const initSqlJs = (await import("../vendor/sql-wasm.js")).default;
    SQL = await initSqlJs({ wasmBinary: readFileSync(wasmPath) });
  } else {
    // vendor/sql-wasm.js 是 UMD 包：它的三条导出分支分别要求 exports/module/define 存在，
    // 在浏览器里用 import() 按 ES Module 解析时三者都没有，**一个导出都不会产生**，
    // 所以这里拿不到 default。改由 index.html 用传统 <script> 标签加载它 ——
    // 传统脚本里顶层 `var initSqlJs` 会落到 window 上，此处直接取全局。
    const initSqlJs = globalThis.initSqlJs;
    if (typeof initSqlJs !== "function") {
      throw new Error("sql.js 未加载：请确认 index.html 中已用 <script src=\"./vendor/sql-wasm.js\"> 引入");
    }
    // wasm 的地址按本模块的位置算，这样无论页面挂在域名根目录还是 /<仓库名>/ 子路径下都能取到
    const wasmBase = new URL("../vendor/", import.meta.url).href;
    SQL = await initSqlJs({ locateFile: (f) => wasmBase + f });
  }
  const bytes = await idbLoad();
  if (bytes && bytes.length > 100) {
    _db = new SQL.Database(bytes);
  } else {
    _db = new SQL.Database();
    _db.run("PRAGMA foreign_keys = ON;");
    _db.exec(SCHEMA_SQL);
  }
  _db.run("PRAGMA foreign_keys = ON;");
  return _db;
}

export function isSeeded() {
  if (!_db) return false;
  const r = scalar("SELECT COUNT(*) FROM customer");
  return r && parseInt(r, 10) > 0;
}

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(persist, 250);
}

export function persist() {
  if (!_db) return;
  const bytes = _db.export();
  idbSave(bytes);
}

// 打开（必要时创建）持久化用的 IndexedDB。
//
// 坑：`indexedDB.open(name)` 不带版本号、又没有 onupgradeneeded 时，
// 全新浏览器里会**建出一个没有任何对象存储的空库**，紧接着 transaction(store) 抛
// NotFoundError；而这个 throw 发生在 onsuccess 回调里，Promise 的 resolve 永远不会执行，
// 于是调用方（boot）永久挂起、页面卡在启动遮罩上。
// 所以这里必须显式给版本号并在 onupgradeneeded 里建好对象存储。
function openIdb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const dbh = req.result;
        if (!dbh.objectStoreNames.contains(IDB_STORE)) dbh.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbSave(bytes) {
  return new Promise(async (resolve) => {
    try {
      const dbh = await openIdb();
      if (!dbh) return resolve();
      const tx = dbh.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
      tx.oncomplete = () => { dbh.close(); resolve(); };
      tx.onerror = () => { dbh.close(); resolve(); };
      tx.onabort = () => { dbh.close(); resolve(); };
    } catch { resolve(); }
  });
}

function idbLoad() {
  return new Promise(async (resolve) => {
    try {
      const dbh = await openIdb();
      if (!dbh) return resolve(null);
      const tx = dbh.transaction(IDB_STORE, "readonly");
      const g = tx.objectStore(IDB_STORE).get(IDB_KEY);
      g.onsuccess = () => { dbh.close(); resolve(g.result || null); };
      g.onerror = () => { dbh.close(); resolve(null); };
    } catch { resolve(null); }
  });
}

export async function resetDatabase() {
  if (_db) { try { _db.close(); } catch {} }
  _db = null;
  await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(IDB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
  return initDatabase();
}
