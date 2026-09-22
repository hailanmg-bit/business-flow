// docs.js — 文档导出（平移自 app/docs.py）。
//
// 对外沟通要的是"能发出去、能打印、能盖章"的文件，不是 CSV。所以产出两种形态：
//   · .docx —— Word 可打开、可编辑、可直接打印盖章
//   · 打印页 HTML —— 浏览器「打印 → 另存为 PDF」，快速出 PDF
//
// 中间用一层极简 block 表示，两种渲染器共用，避免两套排版逻辑走偏。
// 与后端差异：docx 由本文件内置的极简 ZIP 写入器直接产出（无 python-docx 依赖）。
import * as db from "./db.js";

export const OUR_COMPANY = "深圳远见信息技术有限公司";
export const OUR_ADDRESS = "深圳市南山区科技园南区 A 座 20 层";
export const OUR_PHONE = "0755-8600 0000";

// ============ HTML → blocks ============
/** 解析我们自己生成的简易富文本（h3 / p / table）。容忍不规范的写法。 */
export function html_to_blocks(html) {
  const blocks = [];
  if (!html) return blocks;
  const pattern = /<(h3|h2|p|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = pattern.exec(html))) {
    const tag = m[1].toLowerCase(), inner = m[2];
    if (tag === "h3" || tag === "h2") {
      const txt = _plain(inner);
      if (txt) blocks.push({ type: "title", text: txt });
    } else if (tag === "p") {
      const txt = _plain(inner.replace(/<br\s*\/?>/gi, "\n"));
      if (txt.trim()) blocks.push({ type: "p", text: txt.trim() });
    } else {
      const [head, body] = _parse_table(inner);
      if (head.length || body.length) blocks.push({ type: "table", head, rows: body });
    }
  }
  return blocks;
}

function _plain(s) {
  return String(s).replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

function _parse_table(inner) {
  const head = [], body = [];
  const trs = inner.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const ths = (tr.match(/<th\b[^>]*>[\s\S]*?<\/th>/gi) || []).map(x => _plain(x).trim());
    const tds = (tr.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || []).map(x => _plain(x).trim());
    if (ths.length && !head.length) head.push(...ths);
    else if (tds.length) body.push(tds);
  }
  return [head, body];
}

// ============ 模板变量替换 ============
const ITEMS_TOKEN = "\u0000ITEMS\u0000";

/** 替换 {{变量}}。表格型变量 {{明细表}} 留成占位符，由调用方插入表格 block。 */
export function fill_variables(content, ctx) {
  let out = String(content).replace(/\{\{明细表\}\}/g, ITEMS_TOKEN);
  for (const [k, v] of Object.entries(ctx)) {
    out = out.split("{{" + k + "}}").join(v === null || v === undefined ? "" : String(v));
  }
  return out.replace(/\{\{[^}]*\}\}/g, "（待填写）");
}

export function items_table(items) {
  return {
    type: "table",
    head: ["服务/产品名称", "规格说明", "数量", "单价(元)", "金额(元)"],
    rows: items.map(i => [i.name || "", i.spec || "—", String(i.quantity ?? ""), i.unit_price ?? "", i.amount ?? ""]),
  };
}

/** 把含占位符的段落拆开，在占位处插入明细表。 */
function _split_on_items(blocks, items) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "p" && b.text.includes(ITEMS_TOKEN)) {
      const idx = b.text.indexOf(ITEMS_TOKEN);
      const before = b.text.slice(0, idx), after = b.text.slice(idx + ITEMS_TOKEN.length);
      if (before.trim()) out.push({ type: "p", text: before.trim() });
      out.push(items_table(items));
      if (after.trim()) out.push({ type: "p", text: after.trim() });
    } else out.push(b);
  }
  if (!out.some(b => b.type === "table")) out.push(items_table(items));
  return out;
}

// ============ 报价单 ============
export function quotation_blocks(q, template_id = null) {
  const items = db.rows("SELECT * FROM quotation_item WHERE quotation_id=? AND is_deleted=0 ORDER BY sort_no", [q.id]);
  const cust = db.one("SELECT * FROM customer WHERE id=?", [q.customer_id]) || {};

  if (template_id) {
    const ver = db.one("SELECT content FROM contract_template_version WHERE template_id=? ORDER BY created_at DESC LIMIT 1", [template_id]);
    if (ver && ver.content) {
      const ctx = {
        "客户名称": cust.name, "报价单编号": q.quotation_no,
        "报价日期": (q.created_at || "").slice(0, 10), "有效期": q.valid_until,
        "报价金额": q.amount, "付款条件": q.payment_terms || "（待确认）",
        "联系人": cust.contact_name, "电话": cust.contact_phone,
        "地址": cust.address, "乙方名称": OUR_COMPANY,
      };
      return _split_on_items(html_to_blocks(fill_variables(ver.content, ctx)), items);
    }
  }

  // 默认版式（无模板时）
  const total = items.length ? db.fmt_money(items.reduce((s, i) => s + db.to_cents(i.amount), 0)) : q.amount;
  return [
    { type: "title", text: "报 价 单" },
    { type: "kv", items: [
      ["致（客户）", cust.name || ""],
      ["报价单编号", q.quotation_no],
      ["报价日期", (q.created_at || "").slice(0, 10)],
      ["有效期至", q.valid_until],
      ["联系人", cust.contact_name || "—"],
      ["联系电话", cust.contact_phone || "—"],
    ] },
    { type: "p", text: "感谢贵司的信任与接洽。现就相关产品/服务报价如下：" },
    { type: "title", text: "一、报价明细" },
    items_table(items),
    { type: "title", text: "二、报价总额" },
    { type: "p", text: `人民币 ${total} 元（含税）` },
    { type: "title", text: "三、付款条件" },
    { type: "p", text: q.payment_terms || "（待双方协商确定）" },
    { type: "title", text: "四、说明" },
    { type: "p", text: "1. 本报价为要约邀请，最终以双方签署的合同为准。\n"
      + "2. 本报价自报价日起在有效期内有效，逾期需双方另行确认。\n"
      + "3. 如对报价内容有疑问，请随时与我们联系。" },
    { type: "p", text: `\n报价方：${OUR_COMPANY}\n地址：${OUR_ADDRESS}\n电话：${OUR_PHONE}\n日期：${db.today_str()}` },
  ];
}

// ============ 合同 ============
export function contract_blocks(c, version_no = null) {
  const ver = version_no
    ? db.one("SELECT content FROM contract_version WHERE contract_id=? AND version_no=?", [c.id, version_no])
    : db.one("SELECT content FROM contract_version WHERE contract_id=? ORDER BY created_at DESC LIMIT 1", [c.id]);
  let blocks = html_to_blocks((ver || {}).content || "");
  if (!blocks.length) {
    blocks = [{ type: "title", text: c.name }, { type: "p", text: "（本合同暂无正文内容）" }];
  }
  const cust = db.one("SELECT name FROM customer WHERE id=?", [c.customer_id]) || {};
  const items = db.rows("SELECT * FROM contract_item WHERE contract_id=? AND is_deleted=0 ORDER BY sort_no", [c.id]);
  if (items.length && !blocks.some(b => b.type === "table")) {
    blocks.push({ type: "title", text: "服务/产品明细" });
    blocks.push(items_table(items));
  }
  blocks.push({ type: "p", text: `\n合同编号：${c.contract_no}\n客户：${cust.name || ""}\n`
    + `合同金额：${c.amount || "不适用"}${c.amount ? " 元（" + c.amount_type + "）" : ""}\n`
    + `服务期：${c.service_start_date} 至 ${c.service_end_date}` });
  return blocks;
}

// ============ 渲染器：打印页 HTML ============
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export function to_print_html(title, blocks, hint = "") {
  const body = [];
  for (const b of blocks) {
    if (b.type === "title") body.push(`<h3>${esc(b.text)}</h3>`);
    else if (b.type === "kv") {
      const items = b.items.map(([k, v]) => `<div><span class='k'>${esc(k)}</span><span class='v'>${esc(v)}</span></div>`).join("");
      body.push(`<div class='kv'>${items}</div>`);
    } else if (b.type === "p") {
      body.push(`<p>${esc(b.text).replace(/\n/g, "<br/>")}</p>`);
    } else if (b.type === "table") {
      const head = (b.head || []).map(h => `<th>${esc(h)}</th>`).join("");
      const rows_ = (b.rows || []).map(r => "<tr>" + r.map(c => `<td>${esc(c)}</td>`).join("") + "</tr>").join("");
      body.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows_}</tbody></table>`);
    }
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(title)}</title><style>
body{font-family:"Songti SC","SimSun",serif;max-width:800px;margin:0 auto;padding:48px 40px;color:#000;
     font-size:14px;line-height:1.9}
h3{font-size:15px;margin:20px 0 8px}
p{margin:8px 0;white-space:pre-wrap}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}
th,td{border:1px solid #333;padding:6px 8px;text-align:left}
th{background:#f2f2f2}
tbody td:nth-child(n+3){text-align:right}
.kv{margin:10px 0}
.kv>div{display:flex;gap:8px;padding:2px 0}
.kv .k{color:#444;min-width:88px}
.kv .v{font-weight:600}
.bar{position:fixed;top:0;left:0;right:0;background:#0F6E56;color:#fff;padding:9px 16px;
     font-family:-apple-system,"PingFang SC",sans-serif;font-size:13px;display:flex;gap:12px;align-items:center}
.bar button{font:inherit;padding:4px 12px;border-radius:6px;border:0;background:#fff;color:#0F6E56;cursor:pointer}
.bar .grow{flex:1}
@media print{.bar{display:none} body{padding:0}}
</style></head><body>
<div class="bar"><b>${esc(title)}</b><span>${esc(hint)}</span><span class="grow"></span>
<button onclick="window.print()">打印 / 另存为 PDF</button></div>
<div style="height:34px"></div>
${body.join("")}
</body></html>`;
}

// ============ 渲染器：docx ============
// 极简 OOXML：docx = ZIP( [Content_Types].xml, _rels/.rels, word/document.xml )。
// 只写入必要部件，Word / WPS / Pages 均可正常打开。
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 打包为 ZIP（store 模式，不压缩 —— OOXML 允许，且避免引入 deflate 依赖）。 */
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);      // local file header
    lv.setUint16(4, 20, true);              // version needed
    lv.setUint16(6, 0x0800, true);          // flag: UTF-8 文件名
    lv.setUint16(8, 0, true);               // method: store
    lv.setUint16(10, 0, true);              // mod time
    lv.setUint16(12, 0x21, true);           // mod date (1980-01-01)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);      // central directory header
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const total = all.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

const XML_ESC = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function _rpr(size, bold) {
  return "<w:rPr>"
    + '<w:rFonts w:ascii="宋体" w:eastAsia="宋体" w:hAnsi="宋体"/>'
    + (bold ? "<w:b/>" : "")
    + `<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>`
    + "</w:rPr>";
}

function _para(text, size = 10.5, bold = false, align = null) {
  // 多行时每行独立成段（与 python-docx 版行为一致）
  return String(text).split("\n").map(line => {
    const r = `<w:r>${_rpr(size, bold)}<w:t xml:space="preserve">${XML_ESC(line)}</w:t></w:r>`;
    const ppr = align ? `<w:pPr><w:jc w:val="${align}"/></w:pPr>` : "";
    return `<w:p>${ppr}${r}</w:p>`;
  }).join("");
}

function _table(head, body) {
  const cols = Math.max(head.length, ...body.map(r => r.length), 0);
  if (!cols) return "";
  const borders =
    "<w:tblBorders>"
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="333333"/>`).join("")
    + "</w:tblBorders>";
  const w = Math.floor(9000 / cols);
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  const cell = (txt, bold) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>`
    + `<w:p><w:r>${_rpr(10, bold)}<w:t xml:space="preserve">${XML_ESC(txt)}</w:t></w:r></w:p></w:tc>`;
  const headRow = head.length
    ? `<w:tr>${Array.from({ length: cols }, (_, j) => cell(head[j] ?? "", true)).join("")}</w:tr>` : "";
  const bodyRows = body.map(r =>
    `<w:tr>${Array.from({ length: cols }, (_, j) => cell(r[j] ?? "", false)).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${grid}${headRow}${bodyRows}</w:tbl><w:p/>`;
}

/** 生成 .docx（Uint8Array）。 */
export function to_docx(title, blocks) {
  const body = [];
  for (const b of blocks) {
    if (b.type === "title") body.push(_para(b.text, 12, true));
    else if (b.type === "kv") body.push(b.items.map(([k, v]) => _para(`${k}：${v}`, 10.5)).join(""));
    else if (b.type === "p") body.push(_para(b.text, 10.5));
    else if (b.type === "table") body.push(_table(b.head || [], b.rows || []));
  }
  body.push(_para(`导出时间：${db.today_str()}　|　业务通`, 8, false, "right"));

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${XML_ESC(title)}</dc:title><dc:creator>业务通</dc:creator></cp:coreProperties>`;

  const enc = new TextEncoder();
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "docProps/core.xml", data: enc.encode(core) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
  ]);
}
