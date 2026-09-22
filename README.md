# 业务通 · 乙方业务流程管理（网页版）

把本地运行版「业务通」**原样**搬到浏览器的纯前端版本。界面、交互、演示数据与本地体验版**逐项一致**，
但不依赖任何后端服务器 —— 打开网页、填入自己的 DeepSeek API Key 即可使用。

- **界面**：与本地版同一套前端（业务进程 / 客户 / 报价 / 合同 / 模板库 / 提醒 / 智能助手 / 设置），
  抽屉式详情、操作人切换、确认卡、可点击跳转入口全部保留。
- **数据**：演示素材与本地版完全一致（10 家客户、13 份报价单、11 份合同、5 个模板，以及交付/验收/开票/回款记录），
  合同正文按《技术服务合同》示范文本八条生成。
- **数据库**：用 [sql.js](https://github.com/sql-js/sql.js)（SQLite 编译成 WebAssembly）在浏览器内跑**真实 SQLite**，
  数据持久化到 IndexedDB。
- **AI**：浏览器**直连 DeepSeek**（`api.deepseek.com`），Key 只存本机 `localStorage`。
- **逻辑**：`server.py` 的 59 个接口在 `js/api.js` 里用 sql.js 重新实现，响应体逐字段与后端一致，
  确定性规则（三级授权闸门、实体解析、固定口径指标、业务进程推导、提醒调度）全部照搬，一处没松。

> 数据不出本机。唯一的外网请求，是带着你的 Key 向 DeepSeek 发起的模型调用。

## 功能

- **业务进程**：七个阶段看板（报价/签约/交付/验收/开票/回款/完结），按阶段、客户、金额、停滞筛选；
  停滞与回款逾期高亮，含概览统计。
- **客户 / 报价 / 合同**：列表 + 抽屉详情。合同详情含明细、付款计划与核销、版本、附件、履约记录、
  推进记录、业务进程阶段，以及导出 Word / 打印另存 PDF。
- **模板库**：报价单与合同模板（含 `{{变量}}` 占位），可查看正文。
- **提醒**：8 类客观时间事实提醒（报价有效期、合同到期/续签、交付超期、验收超期、开票未开、回款逾期、进程停滞），
  支持一键扫描与标记已读。
- **智能助手**：一句话查数据、录记录、推进状态、问条款。
  - 指标类问题走**固定口径确定性计算**，不靠模型编；
  - 写操作走**三级授权闸门**：一级直接执行（可撤销）、二级出确认卡、三级拒绝（删除/终止/作废/批量/改已生效合同金额）；
  - 任意回答可**追问口径**（「这个怎么算的？」），系统回放上一句的算法与来源；
  - 探索性查询走 NL2SQL，必须过**只读 SELECT 安全闸**（禁写、禁敏感表、自动 LIMIT）。

## 运行

仓库是纯静态文件，任意静态服务器都行：

```bash
cd 业务通网页版
python3 -m http.server 8080     # 或：npx serve .
```

浏览器打开 `http://localhost:8080`。首次进入会引导你填 DeepSeek API Key（**也可跳过，直接看演示数据**）。

> 必须通过 **http(s)://** 访问，不能双击 `index.html` 用 `file://` 打开 —— ES Module 与 WebAssembly 在 `file://` 下会被浏览器拦截。

### 发布到 GitHub Pages

1. 推到 GitHub 仓库；
2. **Settings → Pages → Source 选 "Deploy from a branch"**，分支 `main`，目录 `/ (root)`；
3. 等一两分钟，访问 `https://<用户名>.github.io/<仓库名>/`。

`vendor/` 下的 `sql-wasm.js` 与 `sql-wasm.wasm` 随仓库托管（不走 CDN），所以纯静态托管也能跑。

> 注意：GitHub 免费版**只允许公开仓库开启 Pages**。仓库公开不影响数据隐私 —— 你的业务数据只在自己浏览器的 IndexedDB 里，
> 访问者各自填各自的 Key、各自存各自的数据。

## 性能：为什么代码走 CDN

首屏要下 **约 460KB**，其中 640KB 的 SQLite 引擎（wasm）占 83%。**GitHub Pages 在国内访问极慢**，
实测同一时刻：

| 来源 | 同一个 640KB 引擎 | 效果 |
|---|---|---|
| GitHub Pages | 41 秒 | 单模块延迟 2–9 秒，18 个 JS 模块串起来首屏近 30 秒 |
| raw.githubusercontent | 60 秒超时 | — |
| jsdelivr（代理同一仓库） | **1.4 秒** | 首屏 **5 秒**（缓存热时） |

所以 `index.html` 的引导脚本会**先探测 jsdelivr 是否可用，再决定整套代码从哪加载**：
能用就走 CDN，不能用就原样走本站（本地 `localhost` 只用本站，不引入外部依赖）。
探测后一次性决定 base，不做「加载到一半再回退」—— 否则同一模块会被加载两遍、`boot()` 跑两次。

引擎另有一层保险：拿到后校验字节数（`WASM_BYTES`），不匹配就退回同源 ——
防止 jsdelivr 的 `@main` 边缘缓存给到旧版本，与本地 glue 错配。

> **升级 `vendor/sql-wasm.wasm` 时，记得同步改 `js/db.js` 里的 `WASM_BYTES`**。
> 不改也不会出错，只是会退回同源加载（变慢）。

### 发布：用 `./deploy.sh`，不要直接 `git push`

```bash
./deploy.sh "这次改了什么"
```

它做三件事：推送 → **通知 jsdelivr 清缓存** → 等 Pages 重建并验证资源。
中间那步不能省：jsdelivr 的 `@main` 有约 12 小时边缘缓存，不清的话你 push 完自己要等半天才看到新版。



- **API Key**：只存本机 `localStorage`（键名 `bizflow_deepseek_key`），只发往 `api.deepseek.com`，不经过任何中间服务器。
- **业务数据**：只存本机 IndexedDB（含上传的附件字节），不上传任何地方。清浏览器数据会丢失，请自行导出备份。
- **模型调用**：DeepSeek 允许浏览器跨域直连，无需自建代理。若你的网络需要代理才能出网，请确认浏览器本身能直连外网。
- 设置页可随时更换/清除 Key；「清空并恢复演示数据」可恢复初始演示素材。

## 目录结构

```
业务通网页版/
├── index.html          入口（含启动遮罩与首次 Key 引导）
├── style.css           样式
├── app.js              前端控制器（与本地版 app/web/app.js 同源，仅把数据源换成 js/api.js）
├── deploy.sh           发布脚本：推送 + 清 jsdelivr 缓存 + 验证线上
├── vendor/             sql.js（SQLite wasm），随仓库托管
├── test/               测试：api_test.mjs（逻辑层）/ validate.mjs（引擎层）/ ui_check.mjs（真实浏览器）
└── js/
    ├── db.js           数据访问层（建库 / 持久化 / 金额整数分运算）
    ├── api.js          ★ 浏览器本地 API 层：server.py 的 59 个路由
    ├── catalog.js      动作目录与指标口径（AI 的"宪法"）
    ├── prompts.js      四段提示词
    ├── ai.js           DeepSeek 接入（意图 / NL2SQL / 条款问答 / 安全闸）
    ├── engine.js       意图→动作执行引擎（三级闸门 / 确认卡 / 撤销）
    ├── metrics.js      固定口径指标（确定性计算）
    ├── process.js      业务进程推导
    ├── tasks.js        内置调度（8 类提醒扫描、报价失效、合同到期归档）
    ├── docs.js         文档导出（blocks → docx / 打印页 HTML）
    ├── answer.js       查询结果渲染
    ├── resolution.js   实体解析（客户/合同/报价模糊匹配）
    ├── seed.js         播种逻辑
    └── seed_data.js    演示素材（由 app/seed.py 经 AST 精确转换生成，勿手改）
```

## 测试

分两层，**两层都要跑**：

```bash
# ① 逻辑层（Node，秒级）：59 个接口 + 三级闸门 + 附件 + 文档导出，104 项断言
node test/api_test.mjs
node test/validate.mjs          # 引擎层：录入 / 推进 / 撤销 / 口径追问

# ② 真实浏览器层（本地 Chrome）：页面能不能真的打开、点得动
mkdir -p /tmp/site/business-flow
cp -R app.js index.html style.css js vendor /tmp/site/business-flow/
python3 -m http.server 8098 --directory /tmp/site      # 终端 A
node test/ui_check.mjs http://127.0.0.1:8098/business-flow/   # 终端 B，34 项断言 + 截图 /tmp/ui-*.png
```

逻辑层用桩替代浏览器全局（`localStorage` / `IndexedDB` / `fetch` / `document`），直接 `import` 真实模块跑。

**为什么两层都要跑**：逻辑层全绿**不等于**浏览器里能用。已经栽过两个只有真浏览器才看得见的跟头 ——

1. `vendor/sql-wasm.js` 是 UMD 包，用 `import()` 按 ES Module 解析时它的三条导出分支都不命中，
   拿不到 `initSqlJs`，数据库根本起不来（而 Node 按 CommonJS 处理它，测试却是绿的）；
2. `index.html` 里写了绝对路径 `/style.css`，本地起在根路径恰好能命中，挂到 `/<仓库名>/` 下就 404，样式全丢。

所以 `ui_check.mjs` 特意**在子路径下**跑（模拟 GitHub Pages），根路径测法会漏掉绝对路径问题。
凡动到 `index.html`、模块加载方式、资源路径，都要跑一遍它。

## 与本地运行版的关系

| | 本地版（`app/`） | 网页版（本目录） |
|---|---|---|
| 后端 | FastAPI + SQLite 文件 | 无（`js/api.js` 用 sql.js 在浏览器内实现同一套接口） |
| 前端 | `app/web/` | 同一套（仅数据源与下载方式改为浏览器方式） |
| 数据库 | SQLite | SQLite（wasm），存 IndexedDB |
| 附件 | 落磁盘 `data/uploads/` | 存 IndexedDB |
| docx 导出 | python-docx | 内置极小 ZIP 写入器直接产出 `.docx` |
| 模型 | 服务端调 DeepSeek（Key 在 `.env`） | 浏览器直连 DeepSeek（Key 在 localStorage） |
| 适用 | 自己长期使用 | 发给别人体验 / 静态托管演示 |

设计原则不变：**LLM 只负责「听懂」，不负责「决定」**。风险分级、实体解析、槽位校验、三级拦截、落库、
指标口径全部在确定性代码里完成；风险分级刻意不写进任何提示词。
