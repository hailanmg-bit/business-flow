// seed.js — 素材库（平移自 seed.py）：客户 / 报价单 / 合同 / 模板 / 履约 / 提醒。
import * as db from "./db.js";

const OUR = "深圳远见信息技术有限公司";

const CUSTOMERS = [
  ["宏远科技有限公司", "91310115MA1K3X8N2P", "王建国", "13801234567", "上海市浦东新区张江路 88 号 12 层", "宏远科技有限公司", "91310115MA1K3X8N2P", "招商银行上海张江支行", "121902837465001"],
  ["星联数据服务有限公司", "91110108MA01YWQ33H", "李婷", "13902345678", "北京市海淀区中关村南大街 5 号", "星联数据服务有限公司", "91110108MA01YWQ33H", "中国银行北京中关村支行", "345678901234561"],
  ["中启集团股份有限公司", "91440300MA5EKQ7X9L", "陈志远", "13603456789", "深圳市南山区科技园南区 A 座 20 层", "中启集团股份有限公司", "91440300MA5EKQ7X9L", "工商银行深圳科技园支行", "4000020109200345678"],
  ["汇通供应链管理有限公司", "91320100MA1UTQP21D", "刘敏", "13704567890", "南京市建邺区江东中路 288 号 8 层", "汇通供应链管理有限公司", "91320100MA1UTQP21D", "建设银行南京建邺支行", "3205019876543210"],
  ["恒美医疗科技股份有限公司", "91330100MA2GHK4Q6T", "赵雪", "13505678901", "杭州市滨江区江陵路 588 号 6 号楼", "恒美医疗科技股份有限公司", "91330100MA2GHK4Q6T", "农业银行杭州滨江支行", "19010101040012345"],
  ["蓝图软件（上海）有限公司", "91310104MA1FR8LQ7K", "孙浩", "13406789012", "上海市徐汇区宜山路 900 号 3 号楼", "蓝图软件（上海）有限公司", "91310104MA1FR8LQ7K", "交通银行上海徐汇支行", "3100661234567890"],
  ["东亚物流集团有限公司", "91370200MA3DKQ9P8N", "周涛", "13307890123", "青岛市市南区香港中路 76 号 15 层", "东亚物流集团有限公司", "91370200MA3DKQ9P8N", "浦发银行青岛市南支行", "76010154740001234"],
  ["千帆教育科技有限公司", "91510100MA6CQK2R4M", "吴倩", "13208901234", "成都市高新区天府大道中段 666 号", "千帆教育科技有限公司", "91510100MA6CQK2R4M", "民生银行成都高新支行", "6301012345678901"],
  ["华腾新材料有限公司", "91350100MA2XQK7T5J", "郑海", "13109012345", "厦门市湖里区仙岳路 4688 号 A 栋", "华腾新材料有限公司", "91350100MA2XQK7T5J", "兴业银行厦门湖里支行", "129030100100123456"],
  ["锦程建筑工程有限公司", "91120116MA05QK8U3V", "马强", "13010123456", "天津市滨海新区第二大街 12 号", "锦程建筑工程有限公司", "91120116MA05QK8U3V", "渤海银行天津滨海支行", "2000123456789012"],
];

function contract_body(name, customer, amount, start, end, plan_text, items, accept_days = 30) {
  const item_rows = items ? items.map(i =>
    `<tr><td>${i.name}</td><td>${i.spec || "—"}</td><td>${i.quantity}</td><td>${i.unit_price}</td><td>${i.amount}</td></tr>`).join("") : "";
  const item_table = item_rows ? `<table border='1' cellspacing='0' cellpadding='6'><tr><th>服务项目</th><th>规格说明</th><th>数量</th><th>单价(元)</th><th>金额(元)</th></tr>${item_rows}</table>` : "";
  return `<h3>${name}</h3>
<p><b>委托方（甲方）：</b>${customer}<br/><b>受托方（乙方）：</b>${OUR}</p>
<p><b>第一条 服务内容</b><br/>1.1 服务目标：由乙方向甲方提供本合同约定范围内的技术服务，并交付符合验收标准的服务成果。<br/>1.2 服务内容：需求调研、方案设计、实施部署、培训交底与交付文档编制。</p>
<p><b>第二条 服务期限</b><br/>2.1 服务期限：自 ${start} 起至 ${end} 止。</p>
<p><b>第三条 服务报酬及支付方式</b><br/>3.1 服务报酬总额为人民币 ${amount} 元（含税）。<br/>3.2 支付方式：${plan_text}</p>
${item_table}
<p><b>第四条 验收</b><br/>4.1 乙方完成服务后应书面通知甲方验收。<br/>4.2 甲方应在收到验收通知后 ${accept_days} 日内完成验收；逾期未验收亦未提出书面异议的，视为验收合格。</p>
<p><b>第五条 保密</b><br/>双方对在履行过程中知悉的对方商业秘密负有保密义务，本条款在合同终止后 3 年内持续有效。</p>
<p><b>第六条 成果权利归属</b><br/>服务成果知识产权归甲方所有。</p>
<p><b>第七条 违约责任</b><br/>7.2 乙方逾期完成服务，每逾期一日按服务报酬总额的 0.05% 支付违约金。<br/>7.3 甲方逾期付款，每逾期一日按应付未付款项的 0.05% 支付违约金。</p>
<p><b>第八条 争议解决</b><br/>适用中华人民共和国法律；协商不成的，向乙方所在地有管辖权的人民法院起诉。</p>`;
}

const TEMPLATES = [
  ["报价单（标准版）", "报价单", `<h3>报 价 单</h3><p>致：{{客户名称}}</p><p>报价单编号：{{报价单编号}}　　报价日期：{{报价日期}}　　有效期至：{{有效期}}</p><h3>一、报价明细</h3><p>{{明细表}}</p><h3>二、报价总额</h3><p>人民币 {{报价金额}} 元（含税）</p><h3>三、付款条件</h3><p>{{付款条件}}</p>`],
  ["报价单（简明版）", "报价单", `<h3>{{客户名称}}　报价单</h3><p>编号：{{报价单编号}}　　有效期至：{{有效期}}</p><p>{{明细表}}</p><p><b>合计：人民币 {{报价金额}} 元（含税）</b></p><p>付款条件：{{付款条件}}</p>`],
  ["技术服务合同（标准版）", "服务合同", `<h3>{{合同名称}}</h3><p><b>委托方（甲方）：</b>{{客户名称}}<br/><b>受托方（乙方）：</b>{{乙方名称}}</p><p><b>第一条 服务内容</b><br/>1.1 服务目标：{{服务目标}}<br/>1.2 服务内容：{{服务内容}}</p><p><b>第二条 服务期限</b><br/>自 {{服务开始日期}} 起至 {{服务结束日期}} 止。</p><p><b>第三条 服务报酬及支付方式</b><br/>3.1 服务报酬总额为人民币 {{合同金额}} 元（含税）。<br/>3.2 支付方式：{{付款条件}}</p>{{明细表}}<p><b>第四条 验收</b><br/>甲方应在收到验收通知后 30 日内完成验收；逾期未验收视为验收合格。</p><p><b>第五条 保密</b><br/>保密义务在合同终止后 3 年内持续有效。</p><p><b>第六条 成果权利归属</b><br/>服务成果知识产权归甲方所有。</p><p><b>第七条 违约责任</b><br/>违约方按服务报酬总额的 {{违约金比例}} 支付违约金。</p><p><b>第八条 争议解决</b><br/>适用中华人民共和国法律；争议协商不成的，向乙方所在地法院起诉。</p>`],
  ["产品销售合同（含质保）", "销售合同", `<h3>{{合同名称}}</h3><p><b>买方（甲方）：</b>{{客户名称}}<br/><b>卖方（乙方）：</b>{{乙方名称}}</p><p><b>第一条 标的与价款</b><br/>合同总价款为人民币 {{合同金额}} 元（含税）。</p>{{明细表}}<p><b>第二条 交付</b><br/>乙方应于 {{约定交付日期}} 前送达甲方指定地点。</p><p><b>第三条 验收</b><br/>甲方到货后 7 个工作日内验收；逾期视为验收合格。</p><p><b>第四条 付款方式</b><br/>{{付款条件}}</p><p><b>第五条 质量保证</b><br/>质保期 12 个月。</p>`],
  ["保密协议（NDA）", "保密协议", `<h3>{{合同名称}}</h3><p><b>甲方：</b>{{客户名称}}<br/><b>乙方：</b>{{乙方名称}}</p><p><b>第一条 保密信息</b><br/>包括合作中披露的技术资料、商业计划、客户信息等非公开信息。</p><p><b>第二条 保密义务</b><br/>接收方应以不低于保护自身信息的谨慎程度保护保密信息。</p><p><b>第五条 违约责任</b><br/>违约方赔偿守约方全部直接损失。</p>`],
];

const CONTRACTS = [
  { ci: 4, name: "恒美医疗临床数据管理平台建设服务合同", ctype: "服务合同", amount: "1200000.00", qi: 7, status: "履行中", s: [-13, 352], sign: -13, deliver: -10, renewal: 0, created: -30, owner: 0,
    items: [["临床数据采集平台开发", "定制开发", "1", "800000.00"], ["院内系统集成对接", "接口开发", "1", "250000.00"], ["一年期运维服务", "7×24 响应", "1", "150000.00"]],
    plans: [[1, "360000.00", -5], [2, "480000.00", 150], [3, "360000.00", 320]], fulfil: [] },
  { ci: 2, name: "中启集团企业数据中台技术咨询服务合同", ctype: "服务合同", amount: "600000.00", qi: 2, status: "待签署", s: [-20, 345], sign: null, deliver: 20, renewal: 0, created: -22, owner: 0,
    items: [["数据中台架构设计", "方案设计", "1", "300000.00"], ["数据治理规范编制", "标准文档", "1", "180000.00"], ["技术选型评审支持", "专家服务", "1", "120000.00"]],
    plans: [[1, "180000.00", 30], [2, "420000.00", 200]], fulfil: [] },
  { ci: 6, name: "东亚物流运输轨迹可视化系统服务合同", ctype: "服务合同", amount: "450000.00", qi: 5, status: "履行中", s: [-120, 245], sign: -118, deliver: -50, renewal: 0, created: -122, owner: 1,
    items: [["运输轨迹可视化系统开发", "定制开发", "1", "320000.00"], ["车载终端数据对接", "接口开发", "1", "80000.00"], ["半年期运维服务", "工作日响应", "1", "50000.00"]],
    plans: [[1, "135000.00", -100], [2, "315000.00", 120]],
    fulfil: [["delivery", { content: "运输轨迹可视化系统 V1.0 及部署文档", quantity: "1", ship_date: db.days_ago(45), logistics_no: "SF1029384756", receipt_status: "已签收", receipt_date: db.days_ago(40) }]] },
  { ci: 5, name: "蓝图软件研发效能平台实施服务合同", ctype: "服务合同", amount: "800000.00", qi: 6, status: "履行中", s: [-90, 275], sign: -88, deliver: -30, renewal: 0, created: -92, owner: 0,
    items: [["研发效能平台实施", "定制实施", "1", "520000.00"], ["CI/CD 流水线建设", "工程实施", "1", "180000.00"], ["团队培训与交接", "现场培训", "2", "50000.00"]],
    plans: [[1, "240000.00", -70], [2, "560000.00", 90]],
    fulfil: [["delivery", { content: "研发效能平台实施成果及 CI/CD 流水线", quantity: "1", ship_date: db.days_ago(80), logistics_no: "—", receipt_status: "已签收", receipt_date: db.days_ago(78) }],
      ["acceptance", { accept_date: db.days_ago(40), result: "通过", remark: "功能验收通过" }],
      ["payment", { received_date: db.days_ago(65), amount: "240000.00", serial_no: "SN20260611001" }]] },
  { ci: 0, name: "宏远科技园区能耗监测系统开发合同", ctype: "服务合同", amount: "500000.00", qi: 1, status: "履行中", s: [-55, 310], sign: -50, deliver: -25, renewal: 0, created: -58, owner: 0,
    items: [["能耗监测系统开发", "定制开发", "1", "360000.00"], ["传感器数据接入", "硬件对接", "1", "90000.00"], ["一年期技术支持", "远程支持", "1", "50000.00"]],
    plans: [[1, "150000.00", -40], [2, "350000.00", 200]],
    fulfil: [["delivery", { content: "能耗监测系统 V1.0 及接入说明", quantity: "1", ship_date: db.days_ago(45), logistics_no: "—", receipt_status: "已签收", receipt_date: db.days_ago(44) }],
      ["acceptance", { accept_date: db.days_ago(40), result: "通过", remark: "验收合格" }],
      ["invoice", { invoice_no: "04412026000189", invoice_date: db.days_ago(35), amount: "150000.00", receipt_status: "已签收" }]] },
  { ci: 7, name: "千帆教育在线课程平台运维服务合同", ctype: "服务合同", amount: "300000.00", qi: 4, status: "履行中", s: [-150, 215], sign: -148, deliver: -130, renewal: 0, created: -152, owner: 1,
    items: [["在线课程平台运维服务", "年度运维", "1", "240000.00"], ["数据分析报表定制", "定制开发", "1", "60000.00"]],
    plans: [[1, "150000.00", -120], [2, "150000.00", 60]],
    fulfil: [["delivery", { content: "运维服务交接及报表模块", quantity: "1", ship_date: db.days_ago(128), receipt_status: "已签收", receipt_date: db.days_ago(126) }],
      ["acceptance", { accept_date: db.days_ago(120), result: "通过", remark: "" }],
      ["invoice", { invoice_no: "04412026000077", invoice_date: db.days_ago(115), amount: "150000.00", receipt_status: "已签收" }],
      ["payment", { received_date: db.days_ago(110), amount: "150000.00", serial_no: "SN20260526007" }]] },
  { ci: 3, name: "汇通供应链 SaaS 平台年度订阅服务合同", ctype: "服务合同", amount: "250000.00", qi: 3, status: "履行中", s: [-200, 165], sign: -198, deliver: -190, renewal: 1, created: -202, owner: 0,
    items: [["供应链协同 SaaS 年度订阅", "标准版 50 账号", "1", "200000.00"], ["专属客户成功服务", "年度", "1", "50000.00"]],
    plans: [[1, "125000.00", -180], [2, "125000.00", 120]],
    fulfil: [["delivery", { content: "SaaS 平台账号开通及使用手册", quantity: "1", ship_date: db.days_ago(190), receipt_status: "已签收", receipt_date: db.days_ago(188) }],
      ["acceptance", { accept_date: db.days_ago(185), result: "通过", remark: "" }],
      ["invoice", { invoice_no: "04412026000031", invoice_date: db.days_ago(182), amount: "125000.00", receipt_status: "已签收" }],
      ["payment", { received_date: db.days_ago(178), amount: "125000.00", serial_no: "SN20260320004" }]] },
  { ci: 1, name: "星联数据实时计算平台技术支持服务合同", ctype: "服务合同", amount: "380000.00", qi: 12, status: "履行中", s: [-335, 30], sign: -333, deliver: -320, renewal: 1, created: -338, owner: 1,
    items: [["实时计算平台技术支持", "年度支持", "1", "300000.00"], ["性能调优专项服务", "专项", "1", "80000.00"]],
    plans: [[1, "114000.00", -300], [2, "266000.00", 25]],
    fulfil: [["delivery", { content: "技术支持服务启动及调优报告", quantity: "1", ship_date: db.days_ago(320), receipt_status: "已签收", receipt_date: db.days_ago(318) }],
      ["acceptance", { accept_date: db.days_ago(315), result: "通过", remark: "" }],
      ["invoice", { invoice_no: "04412025000892", invoice_date: db.days_ago(310), amount: "114000.00", receipt_status: "已签收" }],
      ["payment", { received_date: db.days_ago(305), amount: "114000.00", serial_no: "SN20251114002" }]] },
  { ci: 8, name: "华腾新材料实验室信息管理系统实施合同", ctype: "服务合同", amount: "150000.00", qi: 8, status: "履行中", s: [-360, 7], sign: -358, deliver: -345, renewal: 0, created: -362, owner: 0,
    items: [["实验室信息管理系统实施", "标准版实施", "1", "120000.00"], ["基础培训服务", "现场培训", "1", "30000.00"]],
    plans: [[1, "45000.00", -300], [2, "105000.00", 5]],
    fulfil: [["delivery", { content: "LIMS 系统部署及培训交付", quantity: "1", ship_date: db.days_ago(345), receipt_status: "已签收", receipt_date: db.days_ago(343) }],
      ["acceptance", { accept_date: db.days_ago(340), result: "通过", remark: "" }],
      ["invoice", { invoice_no: "04412025000710", invoice_date: db.days_ago(335), amount: "45000.00", receipt_status: "已签收" }],
      ["payment", { received_date: db.days_ago(330), amount: "45000.00", serial_no: "SN20251026003" }]] },
  { ci: 9, name: "锦程建筑工程项目管理信息系统采购合同", ctype: "销售合同", amount: "1800000.00", qi: 9, status: "已到期", s: [-500, -60], sign: -498, deliver: -480, renewal: 0, created: -502, owner: 0,
    items: [["工程项目管理信息系统", "企业版授权 200 用户", "1", "1500000.00"], ["实施部署与数据迁移", "一次性", "1", "240000.00"], ["首年维保服务", "年度", "1", "60000.00"]],
    plans: [[1, "540000.00", -460], [2, "1260000.00", -80]],
    fulfil: [["delivery", { content: "系统企业版授权及部署成果", quantity: "1", ship_date: db.days_ago(480), receipt_status: "已签收", receipt_date: db.days_ago(478) }],
      ["acceptance", { accept_date: db.days_ago(470), result: "通过", remark: "一次性验收通过" }],
      ["invoice", { invoice_no: "04412024000621", invoice_date: db.days_ago(465), amount: "1800000.00", receipt_status: "已签收" }],
      ["payment", { received_date: db.days_ago(460), amount: "540000.00", serial_no: "SN20240610001" }],
      ["payment", { received_date: db.days_ago(78), amount: "1260000.00", serial_no: "SN20260628009" }]] },
  { ci: 3, name: "汇通供应链运营数据看板定制开发合同", ctype: "服务合同", amount: "180000.00", qi: null, status: "草稿", s: [10, 375], sign: null, deliver: 30, renewal: 0, created: -6, owner: 1,
    items: [["运营数据看板开发", "定制开发", "1", "150000.00"], ["移动端适配", "定制开发", "1", "30000.00"]],
    plans: [[1, "54000.00", 20], [2, "126000.00", 120]], fulfil: [] },
];

const QUOTATIONS = [
  [1, null, "已发出", "420000.00", 2, -8, 1, [["实时计算平台扩容服务", "扩容至 200 节点", "1", "340000.00"], ["专项性能调优", "专项服务", "1", "80000.00"]], "合同签订后 7 日内支付 50%，服务交付验收后 30 日内支付剩余 50%"],
  [0, 4, "已转合同", "500000.00", -55, -62, 0, [["能耗监测系统开发", "定制开发", "1", "360000.00"], ["传感器数据接入", "硬件对接", "1", "90000.00"], ["一年期技术支持", "远程支持", "1", "50000.00"]], "签订后 30 日内支付 30%，验收后 60 日内支付 70%"],
  [2, null, "已确认", "600000.00", 25, -25, 0, [["数据中台架构设计", "方案设计", "1", "300000.00"], ["数据治理规范编制", "标准文档", "1", "180000.00"], ["技术选型评审支持", "专家服务", "1", "120000.00"]], "签订后支付 30%，方案交付后支付 70%"],
  [3, 6, "已转合同", "250000.00", -198, -205, 0, [["供应链协同 SaaS 年度订阅", "标准版 50 账号", "1", "200000.00"], ["专属客户成功服务", "年度", "1", "50000.00"]], "年度订阅，签订后一次性支付 50%，半年后支付 50%"],
  [7, 5, "已转合同", "300000.00", -148, -156, 1, [["在线课程平台运维服务", "年度运维", "1", "240000.00"], ["数据分析报表定制", "定制开发", "1", "60000.00"]], "按季度支付，每季度末支付 25%"],
  [6, 2, "已转合同", "450000.00", -118, -126, 1, [["运输轨迹可视化系统开发", "定制开发", "1", "320000.00"], ["车载终端数据对接", "接口开发", "1", "80000.00"], ["半年期运维服务", "工作日响应", "1", "50000.00"]], "签订后支付 30%，上线验收后支付 70%"],
  [5, 3, "已转合同", "800000.00", -88, -96, 0, [["研发效能平台实施", "定制实施", "1", "520000.00"], ["CI/CD 流水线建设", "工程实施", "1", "180000.00"], ["团队培训与交接", "现场培训", "2", "50000.00"]], "分两期：签订后 30%，验收后 70%"],
  [4, 0, "已转合同", "1200000.00", -40, -48, 0, [["临床数据采集平台开发", "定制开发", "1", "800000.00"], ["院内系统集成对接", "接口开发", "1", "250000.00"], ["一年期运维服务", "7×24 响应", "1", "150000.00"]], "三期支付：签订后 30%，中期 40%，验收后 30%"],
  [8, 8, "已转合同", "150000.00", -360, -368, 0, [["实验室信息管理系统实施", "标准版实施", "1", "120000.00"], ["基础培训服务", "现场培训", "1", "30000.00"]], "签订后支付 30%，验收后支付 70%"],
  [9, 9, "已转合同", "1800000.00", -480, -510, 0, [["工程项目管理信息系统", "企业版授权 200 用户", "1", "1500000.00"], ["实施部署与数据迁移", "一次性", "1", "240000.00"], ["首年维保服务", "年度", "1", "60000.00"]], "签订后支付 30%，验收后支付 70%"],
  [2, null, "已失效", "280000.00", -30, -75, 1, [["数据资产盘点服务", "一次性", "1", "200000.00"], ["数据治理培训", "现场培训", "2", "40000.00"]], "签订后一次性支付"],
  [6, null, "草稿", "180000.00", 20, -3, 1, [["物流成本分析模块开发", "定制开发", "1", "150000.00"], ["移动端查询功能", "定制开发", "1", "30000.00"]], "验收后一次性支付"],
  [1, 7, "已转合同", "380000.00", -330, -345, 1, [["实时计算平台技术支持", "年度支持", "1", "300000.00"], ["性能调优专项服务", "专项", "1", "80000.00"]], "年度支持，签订后支付 30%，服务期满支付 70%"],
];

function relDay(n) { return n >= 0 ? db.days_ahead(n) : db.days_ago(-n); }

function fmtItemQty(qty, up) { return db.fmt_money(Math.trunc(parseFloat(qty) * db.to_cents(up))); }

export function seedDatabase() {
  const now = db.now_iso();
  const ops = [];
  for (const nm of ["浩然", "李婷"]) {
    const oid = db.new_id();
    db.run("INSERT INTO operator(id,name,is_active,created_at,is_deleted) VALUES(?,?,1,?,0)", [oid, nm, now]);
    ops.push(oid);
  }
  db.set_setting("current_operator_id", ops[0]);

  const cust_ids = [];
  for (const c of CUSTOMERS) {
    const cid = db.new_id();
    db.run("INSERT INTO customer(id,name,credit_code,contact_name,contact_phone,address,invoice_title,invoice_tax_no,invoice_bank,invoice_account,owner_id,created_at,created_by,updated_at,updated_by,is_deleted) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)", [cid, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], ops[0], now, ops[0], now, ops[0]]);
    cust_ids.push(cid);
  }

  const tpl_ids = [];
  for (const [name, ttype, content] of TEMPLATES) {
    const tid = db.new_id();
    const vars = JSON.stringify(Array.from(new Set((content.match(/\{\{(.+?)\}\}/g) || []).map(s => s.slice(2, -2)))));
    db.run("INSERT INTO contract_template(id,name,template_type,status,current_version_no,variables,source_note,created_at,created_by,updated_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
      [tid, name, ttype, "启用", "V1.0", vars, "条款结构参照《技术服务合同》示范文本", now, ops[0], now]);
    db.run("INSERT INTO contract_template_version(id,template_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [db.new_id(), tid, "V1.0", content, "初始版本", ops[0], now]);
    tpl_ids.push(tid);
  }

  const q_ids = [];
  db.run("DELETE FROM seq_counter WHERE prefix='BJ'");
  for (const [ci, cons_i, status, amount, valid_d, created_d, owner_i, items, terms] of QUOTATIONS) {
    const qid = db.new_id();
    const day = relDay(created_d);
    const no = db.next_no("BJ", day);
    const valid = relDay(valid_d);
    db.run("INSERT INTO quotation(id,quotation_no,customer_id,amount,currency,valid_until,payment_terms,status,owner_id,current_version_no,created_at,created_by,updated_at,updated_by,is_deleted) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)", [qid, no, cust_ids[ci], amount, "CNY", valid, terms, status, ops[owner_i], "V1.0", day + "T09:30:00", ops[owner_i], day + "T09:30:00", ops[owner_i]]);
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

  const c_ids = [];
  db.run("DELETE FROM seq_counter WHERE prefix='HT'");
  CONTRACTS.forEach((cfg) => {
    const cid = db.new_id();
    const s_d = relDay(cfg.s[0]), e_d = relDay(cfg.s[1]);
    const day = relDay(cfg.created);
    const no = db.next_no("HT", day);
    const src_q = cfg.qi !== null ? q_ids[cfg.qi] : null;
    const cust = CUSTOMERS[cfg.ci][0];
    const items = cfg.items.map(a => ({ name: a[0], spec: a[1], quantity: a[2], unit_price: a[3], amount: fmtItemQty(a[2], a[3]) }));
    const plan_text = cfg.plans.map(([n, amt, d]) => `第 ${n} 期 ${amt} 元（约定 ${relDay(d)} 前支付）`).join("；");
    const body = contract_body(cfg.name, cust, cfg.amount, s_d, e_d, plan_text, items);
    db.run("INSERT INTO contract(id,contract_no,name,contract_type,customer_id,amount,amount_type,currency,service_start_date,service_end_date,sign_date,planned_delivery_date,auto_renewal,source_quotation_id,payment_terms,status,owner_id,current_version_no,is_archived,created_at,created_by,updated_at,updated_by,is_deleted) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
      [cid, no, cfg.name, cfg.ctype, cust_ids[cfg.ci], cfg.amount, "合同总额", "CNY", s_d, e_d,
        cfg.sign !== null ? relDay(cfg.sign) : null, cfg.deliver !== null ? relDay(cfg.deliver) : null, cfg.renewal,
        src_q, plan_text, cfg.status, ops[cfg.owner], "V1.0", cfg.status === "已到期" || cfg.status === "已终止" ? 1 : 0,
        day + "T10:00:00", ops[cfg.owner], day + "T10:00:00", ops[cfg.owner]]);
    items.forEach((it, i) => db.run("INSERT INTO contract_item(id,contract_id,name,spec,quantity,unit_price,amount,sort_no,is_deleted) VALUES(?,?,?,?,?,?,?,?,0)",
      [db.new_id(), cid, it.name, it.spec, it.quantity, it.unit_price, it.amount, i]));
    cfg.plans.forEach(([n, amt, d]) => db.run("INSERT INTO contract_payment_plan(id,contract_id,seq_no,plan_amount,due_date,created_at,is_deleted) VALUES(?,?,?,?,?,?,0)",
      [db.new_id(), cid, n, amt, relDay(d), day + "T10:05:00"]));
    db.run("INSERT INTO contract_version(id,contract_id,version_no,content,change_summary,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [db.new_id(), cid, "V1.0", body, "初始版本", ops[cfg.owner], day + "T10:10:00"]);
    const flow = { "待签署": ["待签署"], "履行中": ["待签署", "履行中"], "已到期": ["待签署", "履行中", "已到期"] }[cfg.status] || [];
    const prevMap = { "待签署": "草稿", "履行中": "待签署", "已到期": "履行中" };
    for (const st of flow) {
      db.run("INSERT INTO status_log(id,object_type,object_id,from_status,to_status,changed_by,changed_at,source,remark) VALUES(?,?,?,?,?,?,?,?,?)",
        [db.new_id(), "CONTRACT", cid, prevMap[st], st, ops[cfg.owner], (cfg.sign !== null ? relDay(cfg.sign) : day) + "T15:00:00", "手动", `推进为${st}`]);
    }
    for (const [kind, payload] of cfg.fulfil) {
      const rid = db.new_id();
      const cols = ["id", "contract_id", ...Object.keys(payload), "created_at", "created_by", "updated_at", "is_deleted"];
      const vals = [rid, cid, ...Object.values(payload), now, ops[cfg.owner], now, 0];
      db.run(`INSERT INTO ${kind}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, vals);
    }
    c_ids.push(cid);
  });

  seedReminders(ops, q_ids, c_ids, cust_ids);
  return { customers: cust_ids.length, quotations: q_ids.length, contracts: c_ids.length, templates: tpl_ids.length, operators: ops.length };
}

function seedReminders(ops, q_ids, c_ids, cust_ids) {
  const now = db.now_iso();
  const today = db.today_str();
  // 报价有效期提醒（已发出/已确认 且 7 天内到期）
  for (const q of db.rows("SELECT id, quotation_no, customer_id, valid_until FROM quotation WHERE status IN ('已发出','已确认') AND is_deleted=0")) {
    if (q.valid_until >= today && daysBetween(today, q.valid_until) <= 7) {
      db.run("INSERT INTO reminder(id,remind_type,object_type,object_id,content,triggered_at,is_read) VALUES(?,?,?,?,?,?,0)",
        [db.new_id(), "报价有效期", "QUOTATION", q.id, `报价单 ${q.quotation_no} 将于 ${q.valid_until} 到期`, now]);
    }
  }
  // 合同到期提醒（履行中 且 90 天内到期）
  for (const c of db.rows("SELECT id, contract_no, customer_id, service_end_date FROM contract WHERE status='履行中' AND is_deleted=0")) {
    if (c.service_end_date >= today && daysBetween(today, c.service_end_date) <= 90) {
      db.run("INSERT INTO reminder(id,remind_type,object_type,object_id,content,triggered_at,is_read) VALUES(?,?,?,?,?,?,0)",
        [db.new_id(), "合同到期", "CONTRACT", c.id, `合同 ${c.contract_no} 将于 ${c.service_end_date} 到期`, now]);
    }
  }
}

function daysBetween(a, b) {
  const da = new Date(a), db2 = new Date(b);
  return Math.round((db2 - da) / 86400000);
}
