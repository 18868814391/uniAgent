// ============================================================
//  Sub-Agent 工具 schema —— spawn_sub_agent + get_sub_agent_results
//  由 tool-schemas.js 导入并追加到 TOOLS 数组。
// ============================================================
const { z } = require('zod')

const SUB_AGENT_TOOLS = [
  {
    name: 'spawn_sub_agent',
    description:
      '派发一个子代理并行执行独立子任务。子代理拥有与你相同的全部工具能力（文件 / 代码检索 / 命令行 / 网页测试等），但不能再派生子代理，也不继承你的完整角色约定（只带"当前角色 + 代码仓库根目录 + 检索纪律"）。最多同时运行 2 个。返回后请立即调用 get_sub_agent_results 等待结果。适合场景：需要分别调研/搜索两个独立话题、同时读取多个文件对比分析、分别执行两个独立操作。不适合：单个子任务就需要在大仓库里做宽泛检索（如"去某仓库找某个接口的实现"）——那种任务请自己在主循环里做，或把范围缩到具体模块目录再派发。',
    schema: z.object({
      task: z.string().min(1).describe('子任务的详细描述。必须清晰具体并包含目标与上下文，且**务必写清具体仓库/模块路径**（如 C:/workspace/myapp/src/pages/order）——子代理不知道你的上下文，路径写不清楚它会全库乱搜直到超时'),
      description: z.string().optional().describe('简短标签，用于 UI 状态展示，如"调研 API 方案"'),
    }),
  },
  {
    name: 'get_sub_agent_results',
    description:
      '等待所有已派发的子代理完成并返回结果。调用后会阻塞直到所有子代理结束（最长 10 分钟），期间你无法与用户交互——调用前先告知用户你在等子代理。如果没有任何活跃子代理，直接返回空结果。请在 spawn_sub_agent 之后调用此工具。子代理超时或被中止时，返回结果里会**一并带回它中止前已完成的部分成果**（可能不完整）；此时请基于这些线索自己继续推进，不要把同一个子任务原样重新派发一次。',
    schema: z.object({}),
  },
]

module.exports = { SUB_AGENT_TOOLS }
