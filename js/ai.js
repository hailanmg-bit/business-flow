// ai.js — DeepSeek 接入层（浏览器直连，纯前端）。平移自 ai.py。
//
// 职责边界（严格）：本文件只做「理解」与「表达」。
//   · extract_intent : 意图识别 + 槽位抽取（输出严格 JSON）
//   · nl2sql         : 自然语言 → SELECT（生成后必须过 sql_safe 校验才能执行）
//   · contract_qa    : 基于合同正文回答，强制带引用与免责
//   · polish         : 把结构化结果润色成一句人话
// 风险分级、实体解析、槽位校验、落库 —— 全部不在这里。
//
// 隐私：API Key 只从 localStorage 读取，仅发往 api.deepseek.com，不进任何中间服务器。
import * as catalog from "./catalog.js";
import * as prompts from "./prompts.js";

const BASE_URL = "https://api.deepseek.com";
const STORAGE_KEY = "bizflow_deepseek_key";
const MODEL_KEY = "bizflow_deepseek_model";

export function getApiKey() { return (localStorage.getItem(STORAGE_KEY) || "").trim(); }
export function setApiKey(k) { if (k) localStorage.setItem(STORAGE_KEY, k.trim()); else localStorage.removeItem(STORAGE_KEY); }
export function getModel() { return (localStorage.getItem(MODEL_KEY) || "deepseek-chat").trim(); }

// ---------------- 提示词动态注入 ----------------
function intentSystem() {
  const slot_doc = Object.entries(catalog.SLOT_TYPES).map(([k, v]) => `  - ${k}: ${v}`).join("\n");
  const action_doc = Object.entries(catalog.ACTIONS).map(([name, v]) =>
    `  ${name}（${v.level === 1 ? "一级直接执行" : v.level === 2 ? "二级需确认" : "三级禁止"}）` +
    ` ${v.label}｜必填槽位: ${v.required.join(", ") || "无"}`).join("\n");
  return prompts.INTENT_SYSTEM.replace("{action_doc}", action_doc).replace("{slot_doc}", slot_doc)
    .replace("{today}", todayStr());
}

function schemaHint() {
  const metric_doc = Object.entries(catalog.METRICS).map(([k, v]) =>
    `- ${k}: ${v.definition}（单位 ${v.unit}）`).join("\n");
  return prompts.SCHEMA_HINT.replace("{metric_doc}", metric_doc);
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------- 底层 POST ----------------
async function post(messages, { temperature = 0.0, max_tokens = 900, json_mode = false } = {}) {
  const key = getApiKey();
  if (!key) throw new Error("未配置 DeepSeek API Key（请在设置页填入）");
  const body = {
    model: getModel(),
    messages,
    temperature,
    max_tokens,
    stream: false,
  };
  if (json_mode) body.response_format = { type: "json_object" };
  let res;
  try {
    res = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // 网络 / 代理 / CORS 类错误：fetch 抛 TypeError，没有状态码
    const msg = String(e && e.message || e);
    if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
      throw new Error("网络请求失败：浏览器无法连接到 api.deepseek.com。请检查网络；" +
        "若你处于需要代理才能上网的环境，请确认浏览器本身能直连外网。" + msg);
    }
    throw e;
  }
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = (j.error && (j.error.message || JSON.stringify(j.error))) || ""; }
    catch {}
    if (res.status === 401 || res.status === 403) throw new Error(`DeepSeek 返回 ${res.status}：API Key 无效、被吊销或余额不足。`);
    if (res.status === 429) throw new Error(`DeepSeek 返回 429：调用太频繁被限流，稍等一会儿再试。`);
    throw new Error(`DeepSeek 返回 ${res.status}${detail ? "：" + detail : ""}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

function parseJson(raw) {
  raw = (raw || "").trim();
  raw = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(raw); }
  catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return {};
}

// ---------------- ① 意图识别 + 槽位抽取 ----------------
export async function extract_intent(text, { context = null, history = [] } = {}) {
  const msgs = [{ role: "system", content: intentSystem() }];
  if (context) {
    const ctx = {};
    for (const k of Object.keys(context)) if (context[k]) ctx[k] = context[k];
    if (Object.keys(ctx).length) msgs.push({ role: "system", content: "当前页面上下文（用户可能省略这些信息）：" + JSON.stringify(ctx) });
  }
  for (const h of (history || []).slice(-4)) msgs.push({ role: h.role, content: h.content });
  msgs.push({ role: "user", content: text });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = parseJson(await post(msgs, { json_mode: true, max_tokens: 800 }));
      if (out && Object.keys(out).length) return out;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
  return {};
}

// ---------------- ② NL2SQL ----------------
// 返回 { sql, hint, definition }；NOT_QUERYABLE 时 sql 为 null。
export async function nl2sql(question, history = []) {
  const msgs = [{ role: "system", content: schemaHint() }];
  for (const h of (history || []).slice(-4)) msgs.push({ role: h.role, content: h.content });
  msgs.push({ role: "user", content: question });
  const raw = (await post(msgs, { max_tokens: 700 })).trim();
  if (/NOT_QUERYABLE/i.test(raw)) return { sql: null, hint: "NOT_QUERYABLE", definition: null };

  const m_sql = raw.match(/^\s*SQL\s*[:：]\s*(.+?)\s*$/im);
  const m_def = raw.match(/^\s*口径\s*[:：]\s*(.+?)\s*$/im);

  let sql;
  if (m_sql) sql = m_sql[1].trim();
  else sql = raw; // 模型偶尔不按格式输出，退化成"整段就是 SQL"
  const definition = m_def ? m_def[1].trim() : null;
  return { sql, hint: null, definition };
}

// SQL 安全闸门：只允许单条只读 SELECT，且不得触碰敏感表。
const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|attach|pragma|vacuum|copy)\b/i;
const ALLOWED_TABLES = new Set(["customer", "quotation", "quotation_item", "quotation_version", "contract",
  "contract_item", "contract_payment_plan", "contract_version", "contract_attachment",
  "delivery", "acceptance", "invoice", "payment", "operator", "contract_template",
  "v_contract_amount", "v_business_process"]);
const BLOCKED_TABLES = new Set(["operation_log", "app_setting", "chat_message", "chat_conversation", "seq_counter", "status_log"]);

export function sql_safe(sql) {
  let s = (sql || "").trim();
  // 模型经常无视"不要 markdown"的指示，把 SQL 包在代码块里，先剥壳
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```\s*$/, "");
  }
  s = s.trim().replace(/^`+|`+$/g, "").trim().replace(/;+\s*$/, "").trim();
  s = s.replace(/^\s*--[^\n]*\n/g, "").trim();
  s = s.replace(/^\/\*[\s\S]*?\*\//, "").trim();
  if (!s) return [false, "空语句"];
  if (s.includes(";")) return [false, "禁止多语句"];
  if (!/^(select|with)\b/i.test(s)) return [false, "只允许 SELECT"];
  if (FORBIDDEN.test(s)) return [false, "包含写操作关键字"];
  const found = new Set(s.toLowerCase().match(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi).map((t) => t.replace(/^\s*(?:from|join)\s+/i, "")));
  if ([...found].some((t) => !ALLOWED_TABLES.has(t))) return [false, `访问了未授权表：${[...found].filter((t) => !ALLOWED_TABLES.has(t))}`];
  if ([...found].some((t) => BLOCKED_TABLES.has(t))) return [false, "访问了受限表"];
  if (!/\blimit\b/i.test(s)) s = s + " LIMIT 200";
  return [true, s];
}

// ---------------- ③ 条款问答 ----------------
export async function contract_qa(question, contract_title, content) {
  content = (content || "").trim();
  if (!content) return { answer: "该合同当前版本没有正文内容，无法回答条款问题。", excerpt: "" };
  const msgs = [
    { role: "system", content: prompts.QA_SYSTEM },
    { role: "user", content: `【合同】${contract_title}\n\n【正文】\n${content.slice(0, 12000)}\n\n【问题】${question}` },
  ];
  let raw = (await post(msgs, { temperature: 0.1, max_tokens: 600 })).trim();
  let ans = raw, excerpt = "";
  const m = raw.match(/依据[：:]\s*([\s\S]+)$/);
  if (m) { excerpt = m[1].trim(); ans = raw.slice(0, m.index).trim(); }
  return { answer: ans, excerpt };
}

export function is_legal_question(text) {
  return /合法|违法|法律|风险|有没有效|是否有效|打官司|起诉|合规性/.test(text);
}

// ---------------- ④ 润色 ----------------
export async function polish(instruction, data) {
  try {
    return (await post([
      { role: "system", content: prompts.POLISH_SYSTEM },
      { role: "user", content: `要求：${instruction}\n数据：${data}` },
    ], { temperature: 0.3, max_tokens: 300 })).trim();
  } catch { return ""; }
}

// ---------------- 连通性测试（设置页用） ----------------
export async function testConnection() {
  try {
    const out = await post([{ role: "user", content: "只回复两个字：正常" }], { temperature: 0, max_tokens: 8 });
    return { ok: true, message: "连接成功（" + (out || "").slice(0, 20) + "）" };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}
