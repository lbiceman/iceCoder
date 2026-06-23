const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(process.env.USERPROFILE || 'D:', 'Desktop');
const OUT = path.join(OUT_DIR, '李委冰-前端开发工程师-简历.pdf');
const TMP = path.join(OUT_DIR, '李委冰-简历-tmp.pdf');
fs.mkdirSync(OUT_DIR, { recursive: true });

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 28, bottom: 28, left: 40, right: 40 },
  bufferPages: true,
  info: { Title: '李委冰 — 前端开发工程师', Author: '李委冰' },
});
const ws = doc.pipe(fs.createWriteStream(TMP));
doc.registerFont('cn', 'C:/Windows/Fonts/Deng.ttf');
doc.registerFont('cnb', 'C:/Windows/Fonts/Dengb.ttf');

const W = doc.page.width - 80, L = 40;
const COL = '#1F4E79', TXT = '#333', GRAY = '#888', RED = '#C0392B';

/* ── helpers: pure auto-flow ── */
function sec(t) {
  doc.fillColor(COL).font('cnb').fontSize(12).text(t, L);
  const ny = doc.y;
  doc.moveTo(L, ny).lineTo(L + 28, ny).lineWidth(2.5).strokeColor(RED).stroke();
  doc.moveDown(1.2);
}
function sub(t) {
  doc.fillColor(COL).font('cnb').fontSize(9.5).text(t, L, undefined, { width: W });
  doc.moveDown(0.55);
}
function dot(t) {
  doc.fillColor(TXT).font('cn').fontSize(9.5).text('▸ ' + t, L, undefined, { width: W, lineGap: 2.5 });
  doc.moveDown(0.5);
}
function body(t) {
  doc.fillColor(TXT).font('cn').fontSize(10).text(t, L, undefined, { width: W, lineGap: 3.5 });
  doc.moveDown(0.7);
}
function metric(k, v) {
  doc.fillColor(RED).font('cnb').fontSize(9).text('● ', L, undefined, { continued: true });
  doc.fillColor(COL).font('cnb').fontSize(9).text(k + '  ', undefined, undefined, { continued: true, width: 90 });
  doc.fillColor(TXT).font('cn').fontSize(9).text(v, undefined, undefined, { width: W - 110 });
  doc.moveDown(0.55);
}

/* ═══════════ PAGE 1 ═══════════ */
// Header
doc.rect(0, 0, doc.page.width, 60).fill(COL);
doc.fillColor('#FFF').font('cnb').fontSize(22).text('李委冰', L, 16);
doc.font('cn').fontSize(11).fillColor('#C8D9E8').text('前端开发工程师', L + 120, 22);
doc.fontSize(9).fillColor('#A8C0D4').text('1998年 · 2018年入行 · 7年经验 · 全栈前端方向', L, 42);
doc.y = 66;
doc.fillColor(GRAY).font('cn').fontSize(9);
doc.text('邮箱: lbiceman@126.com  |  GitHub: github.com/lbiceman/iceCoder', L, undefined, {
  link: 'https://github.com/lbiceman/iceCoder'
});
doc.moveDown(1.5);
doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor('#D0D0D0').stroke();
doc.moveDown(0.6);

sec('个人简介');
body('七年前端开发经验，专注 Web 工程化与 AI 工具型产品。独立设计并开源 iceCoder —— 面向本地仓库的 AI 编程助手运行时，通过 Harness 主循环、双模监管、TaskGraph、收尾门控、冰豆宠物可视化与文件化长期记忆，解决长编码任务易跑偏、上下文膨胀、缺乏交付闭环三大痛点。擅长前端架构设计与复杂交互实现，具备从 0 到 1 的全链路产品交付能力。');

sec('核心项目: iceCoder');
body('自托管工具化 LLM 运行时治理层，核心价值是让 AI 长编码任务不跑偏、不丢失上下文、能交付验收。Harness 主循环将模型意图落成可审计的工具执行，配合双模监管、结构化任务图、验收门控与文件化记忆。实测 217+ 轮长会话稳定运行，173 测试文件 / 2048 用例 / ~49s 全量通过。');

// ── 第1页放 4 个模块 ──
sub('① 双模运行时与监管 (L0 / L1 / L2)');
dot('L0 三档 off/adaptive/strict 动态切换；L1 ToolGate 门禁 + BranchBudget 分支预算；L2 Observer 识别跑偏后 takeover→handoff。');

sub('② TaskGraph 与 Harness 主循环');
dot('Harness 落成可审计工具执行：权限裁决、早停、失败检测、上下文压缩与恢复重注入。TaskGraph 为结构化上下文注入源。');

sub('③ 收尾门控 (Acceptance × Verification)');
dot('Acceptance Gate 解析验收命令链全 passed 才停止；Verification Gate 对代码变更强制跑单测。');

sub('④ 冰豆宠物 (Canvas 可视化)');
dot('~20 种表情 + L0 眼色 + L1 角标 + token 环，WebSocket 驱动；桌面端悬浮窗口 + TaskGraph 渲染。');

/* ═══════════ PAGE 2 (pdfkit auto-paginates) ═══════════ */

sub('⑤ 文件化长期记忆');
dot('Markdown 存储无需向量库，TF-IDF 粗召回 + LLM 精排注入；Dream 周期去重，加权淘汰。');

sub('⑥ 提示词系统');
dot('静态 system prompt 与动态 overlay 分离，按任务类型注入上下文；ContextAssembler 组装工具元数据与记忆摘要。');

sub('⑦ 上下文压缩与恢复');
dot('微压缩每轮裁剪无关结果；硬压缩超阈值摘要重注入。CheckpointEngine 断点自动续跑。');

sub('⑧ 多会话与跨端同步');
dot('侧栏增删改查独立会话；~scan 二维码绑定手机与 PC 共享上下文；断线重连恢复 UI 状态。');

sub('⑨ MCP 与子代理');
dot('MCP 子进程并入外部 Server 工具；delegate_to_subagent 只读子代理降低 token ~60-80%。');

sec('项目架构');
body('多入口 (CLI / Web / 桌面端) 统一注入提示词 → Harness 主循环统筹 LLM、工具、上下文与状态 → 文件系统持久化 (checkpoint / memory / events)。构建: TypeScript + Vite + npm pack。');

sec('项目指标');
metric('Harness 稳定性', '217+ 轮长会话稳定运行');
metric('测试基线', '173 文件 / 2048 用例 / ~49s');
metric('记忆模块', '20 文件 / ~391 用例');
metric('桌面端', 'Windows x64 安装包 + Electron + 悬浮冰豆');
metric('监管档位', 'off / adaptive(默认) / strict，侧栏一键切换');

doc.y += 85; // 下移约3cm
sec('技能栈');
dot('前端: TypeScript / Vue / React / Electron / H5 / WebGL · Canvas');
dot('工程化: Vite / Webpack / ESLint / Vitest / Playwright / pnpm');
dot('后端: Node.js / Express / WebSocket / OpenAI API / MCP');
dot('AI 工程: Tool-Use Agent / Prompt Engineering / Context Compaction');

sec('工作经历');
dot('2018.07 – 至今  前端开发工程师  负责中后台系统、可视化大屏、低代码平台、桌面端工具。');
dot('主导多端架构 (Electron + Web SPA + 移动端 H5) 从 0 到 1 落地。');
dot('近两年专注 AI 编程助手运行时，完成 iceCoder 架构设计与桌面端发布。');

sec('自我评价');
body('热爱开源，独立完成 iceCoder 全栈开发并持续迭代。对代码质量和工程化有较高要求，习惯用测试驱动保障重构安全。善于拆解复杂问题，乐于将经验沉淀为工具和文档。关注 AI 前沿技术，持续探索 LLM 与开发流程的深度结合。');

doc.end();

ws.on('finish', () => {
  const buf = fs.readFileSync(TMP);
  const str = buf.toString('latin1');
  let count = 0;
  const re = /\/Type\s*\/Page\b/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (str[m.index + m.length] !== 's') count++;
  }
  console.log('Pages:', count, '| Size:', (buf.length / 1024).toFixed(0), 'KB');
  // try to copy to final name (may fail if locked by reader)
  try { fs.copyFileSync(TMP, OUT); console.log('→', OUT); } catch { console.log('(源文件被占用，临时文件:', TMP, ')'); }
});
ws.on('error', (e) => { console.error('ERR:', e.message); process.exit(1); });
