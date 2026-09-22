// catalog.js — 动作目录与指标口径（平移自 catalog.py）
// 这是 AI 能力的"宪法"：风险分级、必填槽位、指标口径都写死在这里，不进提示词。

export const SLOT_TYPES = {
  customer_ref: "客户引用", contract_ref: "合同引用", quotation_ref: "报价单引用",
  record_ref: "履约记录引用", operator_ref: "操作人引用", template_ref: "模板引用",
  amount: "金额", quantity: "数量", date: "日期", date_range: "日期区间",
  text: "文本", bool: "布尔",
};

// level: 1 直接执行(可撤销) / 2 需确认卡 / 3 永久拒绝
export const ACTIONS = {
  CREATE_CUSTOMER: { level: 1, label: "新建客户", object: "customer", required: ["customer_name"], optional: ["credit_code", "contact_name", "contact_phone", "address", "owner_ref"] },
  CREATE_QUOTATION: { level: 1, label: "新建报价单", object: "quotation", required: ["customer_ref", "amount"], optional: ["valid_until", "payment_terms", "items"] },
  CREATE_DELIVERY: { level: 1, label: "录入交付记录", object: "delivery", required: ["contract_ref", "content", "ship_date"], optional: ["quantity", "logistics_no", "receipt_status", "receipt_date", "remark"] },
  CREATE_ACCEPTANCE: { level: 1, label: "录入验收记录", object: "acceptance", required: ["contract_ref", "accept_date", "accept_result"], optional: ["remark"] },
  CREATE_INVOICE: { level: 1, label: "录入开票记录", object: "invoice", required: ["contract_ref", "invoice_no", "invoice_date", "amount"], optional: ["receipt_status", "remark"] },
  CREATE_PAYMENT: { level: 1, label: "录入回款记录", object: "payment", required: ["contract_ref", "received_date", "amount"], optional: ["serial_no", "remark"] },
  GENERATE_REPORT: { level: 1, label: "生成报告", object: "report", required: ["report_template"], optional: [] },
  CREATE_CONTRACT: { level: 2, label: "新建合同", object: "contract", required: ["customer_ref", "service_start_date", "service_end_date"], optional: ["name", "contract_type", "amount", "amount_type", "sign_date", "planned_delivery_date", "auto_renewal", "payment_terms"] },
  CREATE_CONTRACT_FROM_TEMPLATE: { level: 2, label: "模板生成合同", object: "contract", required: ["customer_ref", "template_ref", "service_start_date", "service_end_date"], optional: ["name", "contract_type", "amount", "amount_type", "variables", "sign_date"] },
  CONVERT_QUOTATION_TO_CONTRACT: { level: 2, label: "报价转合同", object: "contract", required: ["quotation_ref", "service_start_date", "service_end_date"], optional: ["name", "contract_type", "amount", "amount_type", "planned_delivery_date", "payment_terms"] },
  CREATE_PAYMENT_PLAN: { level: 2, label: "新增付款期次", object: "payment_plan", required: ["contract_ref", "seq_no", "plan_amount", "due_date"], optional: ["remark"] },
  UPDATE_CUSTOMER: { level: 2, label: "修改客户", object: "customer", required: ["customer_ref", "fields"], optional: [] },
  UPDATE_CONTRACT: { level: 2, label: "修改合同", object: "contract", required: ["contract_ref", "fields"], optional: [] },
  UPDATE_QUOTATION: { level: 2, label: "修改报价单", object: "quotation", required: ["quotation_ref", "fields"], optional: [] },
  UPDATE_DELIVERY: { level: 2, label: "修改交付记录", object: "delivery", required: ["record_ref", "fields"], optional: [] },
  UPDATE_ACCEPTANCE: { level: 2, label: "修改验收记录", object: "acceptance", required: ["record_ref", "fields"], optional: [] },
  UPDATE_INVOICE: { level: 2, label: "修改开票记录", object: "invoice", required: ["record_ref", "fields"], optional: [] },
  UPDATE_PAYMENT: { level: 2, label: "修改回款记录", object: "payment", required: ["record_ref", "fields"], optional: [] },
  ADVANCE_QUOTATION_STATUS: { level: 2, label: "推进报价单状态", object: "quotation", required: ["quotation_ref", "to_status"], optional: ["remark"] },
  ADVANCE_CONTRACT_STATUS: { level: 2, label: "推进合同状态", object: "contract", required: ["contract_ref", "to_status"], optional: ["remark"] },
  ARCHIVE_CONTRACT: { level: 2, label: "归档合同", object: "contract", required: ["contract_ref"], optional: [] },
  UNARCHIVE_CONTRACT: { level: 2, label: "取消归档", object: "contract", required: ["contract_ref"], optional: [] },
  CREATE_CONTRACT_VERSION: { level: 2, label: "创建合同版本", object: "contract", required: ["contract_ref", "content"], optional: ["change_summary"] },
  DELETE_ANY: { level: 3, label: "删除对象", object: "*", required: [], optional: [] },
  TERMINATE_CONTRACT: { level: 3, label: "合同终止", object: "contract", required: ["contract_ref"], optional: [] },
  VOID_CONTRACT: { level: 3, label: "合同作废", object: "contract", required: ["contract_ref"], optional: [] },
  VOID_QUOTATION: { level: 3, label: "报价单作废", object: "quotation", required: ["quotation_ref"], optional: [] },
  UPDATE_CONTRACT_AMOUNT_EFFECTIVE: { level: 3, label: "改已生效合同金额", object: "contract", required: ["contract_ref", "amount"], optional: [] },
  BATCH_OPERATION: { level: 3, label: "批量操作", object: "*", required: [], optional: [] },
  UPLOAD_ATTACHMENT: { level: 3, label: "上传附件", object: "contract", required: [], optional: [] },
};

export const ACTION_ALIASES = {
  RECORD_PAYMENT: "CREATE_PAYMENT", CREATE_RECEIPT: "CREATE_PAYMENT", ADD_PAYMENT: "CREATE_PAYMENT",
  RECORD_DELIVERY: "CREATE_DELIVERY", ADD_DELIVERY: "CREATE_DELIVERY",
  RECORD_ACCEPTANCE: "CREATE_ACCEPTANCE", ADD_ACCEPTANCE: "CREATE_ACCEPTANCE",
  RECORD_INVOICE: "CREATE_INVOICE", ADD_INVOICE: "CREATE_INVOICE",
  ADD_CUSTOMER: "CREATE_CUSTOMER", NEW_CUSTOMER: "CREATE_CUSTOMER",
  ADD_CONTRACT: "CREATE_CONTRACT", NEW_CONTRACT: "CREATE_CONTRACT",
  CREATE_QUOTE: "CREATE_QUOTATION", ADD_QUOTATION: "CREATE_QUOTATION",
  QUOTATION_TO_CONTRACT: "CONVERT_QUOTATION_TO_CONTRACT", CONVERT_TO_CONTRACT: "CONVERT_QUOTATION_TO_CONTRACT",
  UPDATE_STATUS: "ADVANCE_CONTRACT_STATUS", ADVANCE_STATUS: "ADVANCE_CONTRACT_STATUS",
  CHANGE_STATUS: "ADVANCE_CONTRACT_STATUS", PUSH_STATUS: "ADVANCE_CONTRACT_STATUS",
  DELETE: "DELETE_ANY", DELETE_CONTRACT: "DELETE_ANY", DELETE_CUSTOMER: "DELETE_ANY",
  TERMINATE: "TERMINATE_CONTRACT", VOID: "VOID_CONTRACT", ARCHIVE: "ARCHIVE_CONTRACT",
  UPDATE: "UPDATE_CONTRACT", MODIFY_CONTRACT: "UPDATE_CONTRACT", EDIT_CONTRACT: "UPDATE_CONTRACT",
};

export const TRANSITIONS = {
  QUOTATION: { "草稿": ["已发出", "已作废"], "已发出": ["已确认", "已失效", "已作废"], "已确认": ["已转合同", "已作废"], "已转合同": [], "已失效": [], "已作废": [] },
  CONTRACT: { "草稿": ["待签署", "已作废"], "待签署": ["履行中", "已作废"], "履行中": ["已到期", "已终止", "已作废"], "已到期": [], "已终止": [], "已作废": [] },
};
export const CONTRACT_TERMINAL = new Set(["已到期", "已终止", "已作废"]);
export const QUOTATION_TERMINAL = new Set(["已转合同", "已失效", "已作废"]);

export const FIELD_LABELS = {
  name: "名称", customer_id: "客户", amount: "金额", amount_type: "金额口径", sign_date: "签署日期",
  service_start_date: "服务开始日期", service_end_date: "服务结束日期", planned_delivery_date: "约定交付日期",
  auto_renewal: "自动续约", payment_terms: "付款条件", status: "状态", owner_id: "负责人",
  contract_type: "合同类型", remark: "备注", valid_until: "有效期", received_date: "到账日期",
  ship_date: "发货日期", receipt_status: "签收状态", receipt_date: "签收日期", accept_date: "验收日期",
  result: "验收结果", invoice_no: "发票号", invoice_date: "开票日期", contact_name: "联系人",
  contact_phone: "电话", address: "地址", serial_no: "流水号", content: "交付内容", quantity: "数量", logistics_no: "物流单号",
};

export const METRICS = {
  签约数: { keywords: ["签了多少", "签约数", "签了几份", "新签", "签订数"], definition: "统计区间内 sign_date 落在其间的合同数（sign_date 为空时取创建时间），排除草稿与已作废", unit: "份" },
  合同总金额: { keywords: ["合同总额", "合同总金额", "签了多少钱", "合同金额合计"], definition: "统计区间内合同的 amount 之和，amount_type = 不适用 的合同不计入", unit: "元" },
  未回款金额: { keywords: ["还有多少没回", "未回款", "没回的款", "欠款", "应收"], definition: "sum(合同金额 − 已回款)，口径取自 v_contract_amount；amount_type = 不适用 的合同不适用", unit: "元" },
  已回款金额: { keywords: ["回了多少款", "已回款", "回款总额", "到账多少"], definition: "统计区间内 received_date 落在其间的回款记录 amount 之和", unit: "元" },
  回款率: { keywords: ["回款率"], definition: "已回款金额 ÷ 合同金额，amount_type = 不适用 的合同不计入分母", unit: "%" },
  报价转化率: { keywords: ["转化率", "报价转化"], definition: "已转合同的报价单数 ÷ 已发出过的报价单数（分母排除草稿与已作废）", unit: "%" },
  逾期合同数: { keywords: ["逾期", "超期没回", "拖欠"], definition: "存在付款期次 due_date < 今日且该期未回款的合同数", unit: "份" },
  停滞单数: { keywords: ["卡住", "停滞", "没动", "积压", "停在那"], definition: "业务进程中当前阶段停留天数超过阈值的单数", unit: "单" },
  在办业务数: { keywords: ["在办", "有多少单在跑", "进行中的业务", "在建"], definition: "业务进程中 current_stage ≠ 已完结 的单数", unit: "单" },
  平均签约周期: { keywords: ["签约周期", "从报价到签合同", "多久能签"], definition: "avg(合同创建时间 − 来源报价单创建时间)，仅统计有来源报价单的合同", unit: "天" },
};

export const NON_QUERYABLE = {
  付款条件: "付款条件是自由文本，无法统计汇总。我可以逐份列出相关合同的付款条件原文，需要吗？",
  地址: "地址未结构化，无法作为筛选条件。可以按客户名称搜索，或者我列出全部客户供你查看。",
  备注: "备注是自由文本，无法统计。我可以列出含相关备注的记录供你核对。",
  交付内容: "交付内容是自由文本描述，无法汇总统计。可以按发货日期、签收状态等结构化字段筛选。",
  物流单号: "物流单号是记录明细，无法用于统计。可以按签收状态筛选交付记录。",
  发票号: "发票号是记录明细，我可以列出该合同的开票记录供你核对。",
  流水号: "流水号是记录明细，我可以列出该合同的回款记录供你核对。",
};
