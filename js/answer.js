// answer.js — 查询结果的拟人化渲染（平移自 answer.py）。不交给模型润色，因为润色是编数入口。
import * as db from "./db.js";

export const COLUMN_LABELS = {
  customer_name: "客户", name: "名称", contract_name: "合同", contract_no: "合同编号", quotation_no: "报价单编号",
  process_type: "类型", amount: "金额", currency: "币种", unpaid_amount: "未回款", paid_amount: "已回款",
  invoice_amount: "已开票", contract_amount: "合同金额", plan_amount: "约定金额", allocated_amount: "已核销",
  paid_rate: "回款率", status: "状态", current_stage: "当前阶段", stage_days: "停留", is_stagnant: "是否停滞",
  is_archived: "已归档", amount_type: "金额口径", contract_type: "合同类型", service_start_date: "服务开始",
  service_end_date: "服务结束", sign_date: "签署日期", planned_delivery_date: "约定交付", auto_renewal: "自动续约",
  due_date: "约定回款日", received_date: "到账日期", ship_date: "发货日期", receipt_date: "签收日期",
  receipt_status: "签收状态", accept_date: "验收日期", result: "验收结果", invoice_no: "发票号", invoice_date: "开票日期",
  valid_until: "有效期", owner_name: "负责人", seq_no: "期次", remark: "备注", count: "数量", cnt: "数量", num: "数量",
  total: "合计", n: "数量", conversion_rate: "转化率", rate: "比率", avg_days: "平均天数", days: "天数",
  customer_count: "客户数", contract_count: "合同数", payment_count: "回款笔数", serial_no: "流水号",
  contact_name: "联系人", contact_phone: "电话", credit_code: "统一社会信用代码", address: "地址", content: "交付内容",
  logistics_no: "物流单号", quantity: "数量", unit_price: "单价", created_at: "创建时间", updated_at: "更新时间",
};

export const MONEY_COLS = new Set(["amount", "unpaid_amount", "paid_amount", "invoice_amount", "contract_amount", "plan_amount", "allocated_amount", "unit_price", "total_amount", "sum_amount"]);
export const RATE_COLS = new Set(["paid_rate", "conversion_rate", "rate"]);
export const SKIP_COLS = new Set(["id", "process_id", "contract_id", "quotation_id", "customer_id", "owner_id", "created_by", "updated_by", "is_deleted", "source_quotation_id", "template_id", "payment_plan_id", "object_id", "operator_id", "conversation_id", "refresh"]);
export const SKIP_SUFFIX = "_id";
export const PRIORITY = ["customer_name", "contract_name", "contract_no", "quotation_no", "name", "amount", "contract_amount", "unpaid_amount", "paid_amount", "invoice_amount", "status", "current_stage", "stage_days", "is_stagnant", "amount_type", "due_date", "service_end_date", "sign_date", "received_date", "owner_name", "count", "cnt", "num", "total", "n", "conversion_rate", "rate", "plan_amount", "allocated_amount", "seq_no", "valid_until", "contract_type"];
export const TYPE_LABELS = { CONTRACT: "合同", QUOTATION: "报价单" };
export const TABLE_LABELS = {
  customer: "客户档案", quotation: "报价台账", quotation_item: "报价明细", quotation_version: "报价版本",
  contract: "合同台账", contract_item: "合同明细", contract_payment_plan: "付款计划", contract_version: "合同版本",
  delivery: "交付记录", acceptance: "验收记录", invoice: "开票记录", payment: "回款记录", operator: "操作人",
  contract_template: "合同模板", attachment: "附件", v_contract_amount: "金额口径视图", v_business_process: "业务进程视图",
  process_snapshot: "业务进程",
};
export const MAX_FIELDS = 7;
export const MAX_ROWS = 50;

function _label(col) { return COLUMN_LABELS[col] || col; }
function _order(cols) { return cols.slice().sort((a, b) => (PRIORITY.indexOf(a) >= 0 ? PRIORITY.indexOf(a) : 999) - (PRIORITY.indexOf(b) >= 0 ? PRIORITY.indexOf(b) : 999)); }

export function humanize(col, val) {
  if (SKIP_COLS.has(col) || col.endsWith(SKIP_SUFFIX)) return null;
  if (val === null || val === "") return null;
  if (col === "process_type") return TYPE_LABELS[val] || val;
  if (["is_stagnant", "is_archived", "auto_renewal"].includes(col)) return (val === 1 || val === "True" || val === "true") ? "是" : "否";
  if (col === "amount_type") return String(val);
  const low = col.toLowerCase();
  if (MONEY_COLS.has(col) || low.includes("amount") || low.startsWith("sum(") || ["total", "合计"].includes(low)) {
    try { return "¥" + (db.to_cents(val) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    catch { return String(val); }
  }
  if (RATE_COLS.has(col)) return `${val}%`;
  if (col === "stage_days") return `${val} 天`;
  if (["quantity", "seq_no"].includes(col)) return col === "seq_no" ? `第 ${val} 期` : String(val);
  const s = String(val);
  if (col.endsWith("_at") && s.length >= 16) return s.slice(0, 16).replace("T", " ");
  if (col.endsWith("_date") && s.length >= 10) return s.slice(0, 10);
  return s;
}

function _cell(col, row) {
  const v = humanize(col, row[col]);
  if (v === null) return null;
  if (!COLUMN_LABELS[col] && !/[\u4e00-\u9fff]/.test(col)) return v;
  return `${_label(col)} ${v}`;
}

export function compose(cols, data, question = "") {
  if (!data.length) return "没有查到符合条件的数据。";
  let usable = cols.filter(c => humanize(c, data[0][c]) !== null);
  if (!usable.length) usable = cols.filter(c => !c.endsWith("_id") && !SKIP_COLS.has(c)).slice(0, 4);
  usable = _order(usable);
  if (data.length === 1) {
    const row = data[0];
    const cells = usable.map(c => _cell(c, row)).filter(Boolean);
    if (!cells.length) return "查到 1 条记录，但没有可展示的字段。";
    if (cells.length === 1) return cells[0] + "。";
    if (cells.length > MAX_FIELDS) return " · ".join(cells.slice(0, MAX_FIELDS)) + `（另有 ${cells.length - MAX_FIELDS} 项，可到详情页查看）`;
    return " · ".join(cells);
  }
  const shown = data.slice(0, MAX_ROWS);
  const lines = shown.map((row, i) => `${i + 1}. ` + usable.slice(0, 6).map(c => _cell(c, row)).filter(Boolean).join(" · "));
  const tail = data.length > shown.length ? `\n…… 共 ${data.length} 条，仅显示前 ${shown.length} 条` : "";
  return `查到 ${data.length} 条：\n` + lines.join("\n") + tail;
}

export function metric_reply(metric) {
  const head = `${metric.metric}：${metric.value} ${metric.unit}`;
  const items = metric.items || [];
  if (!items.length) {
    if (/^0(\.0+)?$/.test(String(metric.value || "").trim())) return head + "\n（该区间内没有符合条件的记录）";
    return head;
  }
  const lines = items.slice(0, MAX_ROWS).map(it => `· ${it.label || it.id}`);
  if (items.length > MAX_ROWS) lines.push(`……另有 ${items.length - MAX_ROWS} 条`);
  return head + "\n" + lines.join("\n");
}

export function table_labels(names) { return (names || []).map(n => TABLE_LABELS[n] || n); }
export function metric_detail(metric) { return `口径：${metric.definition}`; }
