// ============================================================
//  全局共享可变状态 —— 拆分子模块之间的通讯总线
//  各模块统一通过 state.xxx 读写;settings / loginInfo / userResources
//  允许整体替换(直接给 state.x 赋新对象),主窗口等字段直接赋值。
//  注意:不要在任何模块里 `const { settings } = state` 解构缓存引用,
//  因为整体替换后局部引用会指向旧对象。一律用 state.x 访问。
// ============================================================

module.exports = {
  // 主窗口(唯一);窗口关闭时置 null
  mainWindow: null,
  // 已打开的 md 预览独立窗口:{ window, filePath }
  mdPreviewWindows: [],
  // 应用设置(loadSettings 整体替换)
  settings: {},
  // 并发会话运行槽:key=conversationId,值 { controller, stopRequested, pendingAsk }
  chatRuns: new Map(),
  // 结构化任务清单（update_todos 工具）:key=conversationId,值 [{ text, status }]
  // 每轮请求末尾会追加回显给模型（见 tools/todo.js 头部注释），删除会话时清理
  todos: new Map(),
  // 会话标题 AI 生成去重
  pendingTitleFor: new Set(),
  // 用户"导入文件"附加的文件路径(授予读取权限,仅当前会话内存中)
  attachedFilePaths: new Set(),
  // ask_user 问题 id 自增
  askSeq: 0,
  // 子 Agent 运行槽：key=subAgentId, value={ convId, task, description, status, promise, controller, startedAt, completedAt }
  subAgents: new Map(),
  // 子 Agent 等待标记：key=convId, value=true 时禁用空闲计时器
  subAgentsPending: new Map(),
  // 子 Agent ID 自增
  subAgentSeq: 0,
  // git 可执行文件探测结果缓存
  cachedGitCmd: null,
  gitProbeDone: false,
}