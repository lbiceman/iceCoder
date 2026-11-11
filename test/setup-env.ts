/**
 * 测试进程环境隔离。
 *
 * iceCoder 主进程（桌面端 / 自测 / run_command 子进程）会注入一批 ICE_* 运行期变量，
 * 并可能带着 NODE_ENV=production。这些值泄漏进测试进程后，所有「默认值」类断言
 * （数据根、默认工作目录、静态资源缓存策略、隧道跳转）都会读到宿主的值而不是默认值，
 * 表现成几十个失败，看起来像产品坏了。
 *
 * 这里把运行期环境复位到测试应有的状态；各用例自己设置的值仍然生效。
 */

const INHERITED_RUNTIME_ENV = [
  'ICE_ELECTRON',
  'ICE_CACHE_ROOT',
  'ICE_CONFIG_PATH',
  'ICE_MCP_CONFIG_PATH',
  'ICE_SESSIONS_DIR',
  'ICE_MEMORY_DIR',
  'ICE_USER_MEMORY_DIR',
  'ICE_OUTPUT_DIR',
  'ICE_SERVER_ROOT',
  'ICE_SKILLS_DIR',
  'ICE_AGENTS_DIR',
  'ICE_DEFAULT_WORK_DIR',
  'ICE_AGENT_ROOT_PID',
  'ICE_AGENT_SESSION',
  'ICE_TUNNEL_DEV',
];

for (const name of INHERITED_RUNTIME_ENV) {
  delete process.env[name];
}

// 删除而非改成 'test'：NODE_ENV=production 会让 usesUserDataRoot() 变 true，
// 数据根切到 ~/.iceCoder，静态资源也进入生产缓存分支。
// 用未设置态最贴近各用例自己的假设（它们会自行 delete / 设置该值）。
delete process.env.NODE_ENV;
