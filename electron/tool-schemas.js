// ============================================================
//  工具定义注册表 —— 单一数据源（zod schema）
//  每个工具 = 普通函数（handler 在 main.js 的 TOOL_HANDLERS 中）+ zod schema。
//  - zodToJsonSchema()：把 zod schema 转成 OpenAI function parameters JSON schema，
//    自动派生发给模型的 tools 定义，避免手写静态 schema 漏字段/写错类型。
//  - TOOLS：全部工具 { name, description, schema }，执行前由 main.js 用 safeParse 校验。
//
//  注意：依赖 zod v3 的 _def 内部结构（已 pin zod@^3.24.1，实际装到 3.25.x）。
//  若升级 zod 大版本，_def 结构会变，先跑 tests/tool-schemas.test.js 的
//  快照校验，确认生成的 JSON schema 与现状一致再上线。
// ============================================================
const { z } = require('zod')
const { SUB_AGENT_TOOLS } = require('./tool-schemas-subagent')

// 任意对象：作为"透传 payload"字段（browser_eval.arg）
const anyObject = () => z.record(z.string(), z.unknown())

/**
 * zod schema → OpenAI function parameters JSON schema。
 * 只覆盖本项目用到的类型（string/number/boolean/enum/object/array/record/optional），
 * 输出与旧的手写 schema 逐字段等价（不输出 additionalProperties/minLength/maxItems，
 * 保证发给模型的定义零回归；约束仅由 safeParse 校验时生效）。
 */
function zodToJsonSchema(schema) {
  return convert(schema)
}

function convert(schema) {
  const def = schema._def
  let out
  switch (def.typeName) {
    case 'ZodString':
      out = { type: 'string' }
      break
    case 'ZodNumber':
      out = { type: 'number' }
      break
    case 'ZodBoolean':
      out = { type: 'boolean' }
      break
    case 'ZodEnum':
      out = { type: 'string', enum: def.values }
      break
    case 'ZodArray':
      out = { type: 'array', items: convert(def.type) }
      break
    case 'ZodRecord':
      // 任意对象（browser_eval.arg / read_file.body）—— 与旧 schema 的 { type:'object' } 等价
      out = { type: 'object' }
      break
    case 'ZodObject': {
      const shape = def.shape()
      out = { type: 'object', properties: {} }
      const required = []
      for (const [key, valueSchema] of Object.entries(shape)) {
        out.properties[key] = convert(valueSchema)
        if (valueSchema._def.typeName !== 'ZodOptional') required.push(key)
      }
      if (required.length > 0) out.required = required
      break
    }
    case 'ZodOptional':
      // 解包内层，保留 optional 外层可能携带的 description
      out = convert(def.innerType)
      if (def.description) out.description = def.description
      break
    case 'ZodDefault':
      out = convert(def.innerType)
      break
    default:
      out = { type: 'object' }
      break
  }
  if (!out.description && def.description) out.description = def.description
  return out
}

const TOOLS = [
  {
    name: 'read_file',
    description: "Read a file's ENTIRE content (the whole file by default). Read it ONCE and completely — do NOT split a file into small chunks. Only pass offset/limit when the file is genuinely huge and you need one specific region. Genuinely huge files (over ~8000 lines / 128 KB) are auto-truncated: the result then has truncated:true plus totalLines/nextOffset — continue from nextOffset instead of shrinking limit and guessing. Re-reading the same file with the same arguments returns no new information — it only wastes a turn.",
    schema: z.object({
      path: z.string().describe('Absolute path to the file'),
      offset: z.number().int().min(1).optional().describe('Start line number (1-based). Omit to read from the beginning — this is almost always what you want.'),
      limit: z.number().int().min(1).optional().describe('Max number of lines. Omit to read the whole file — this is almost always what you want.'),
    }),
  },
  {
    name: 'read_image',
    description:
      'Feed a LOCAL image FILE to yourself as a real image (vision) — you then actually SEE its content. Use it whenever the picture lives on disk: the user gives you an image path, an image was downloaded / extracted from a .docx / saved from a wiki page, or you just exported or captured a picture. NEVER use read_file on a picture (it refuses and tells you the same thing). Supports .png/.jpg/.jpeg/.webp, max 10MB each, at most 4 per call; large images are auto-downsampled. The images are attached to your NEXT message, so after calling it you can describe what is in them. Only available when the active model profile is marked vision-capable — if it is not, the tool tells you exactly what to ask the user to turn on. Documents count too: when the material is a spec / PRD / wiki page / design draft, pull the embedded pictures out first (docx → unzip and read word/media/; pdf → extract with pypdf; a scanned pdf is just page images) instead of reporting on the text alone. When there are many pictures, look at the important ones (ones the text points at, prototype screens, flow charts, field/table screenshots) and tell the user honestly how many you looked at and which ones you skipped.',
    schema: z.object({
      path: z.string().optional().describe('Absolute path of a single image file. Use this for the common case (one image).'),
      paths: z.array(z.string()).optional().describe('Absolute paths of up to 4 images, when you need several at once (kept in this order).'),
    }),
  },
  {
    name: 'write_file',
    description:
      'Write content to a file in an allowed directory. Creates parent directories if needed. The result includes a unified diff of what changed — read it to confirm the file now contains what you intended, instead of re-reading the whole file. When the result has diffTruncated:true the diff is only partial, so read the file if you need the full picture.',
    schema: z.object({
      path: z.string().describe('Absolute path to the file'),
      content: z.string().describe('Content to write'),
    }),
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories in a directory',
    schema: z.object({
      path: z.string().describe('Absolute path to the directory'),
    }),
  },
  {
    name: 'delete_file',
    description: 'Delete a file in an allowed directory',
    schema: z.object({
      path: z.string().describe('Absolute path to the file'),
    }),
  },
  {
    name: 'edit_file',
    description:
      'Surgically edit a file by replacing an exact string match (str_replace). Use this instead of write_file when modifying existing files — it preserves the rest of the file and uses fewer tokens. The old_string must be an exact match of the text to replace (including whitespace and indentation). If old_string appears more than once, set replace_all=true or provide more context to make it unique. The result includes a unified diff of the applied change — read it to confirm the edit landed as intended, instead of re-reading the whole file. When the result has diffTruncated:true the diff is only partial, so read the file if you need the full picture.',
    schema: z.object({
      path: z.string().describe('Absolute path to the file'),
      old_string: z
        .string()
        .min(1, 'old_string 不能为空字符串')
        .describe('The exact text to find and replace (must match exactly, including indentation)'),
      new_string: z.string().describe('The replacement text'),
      replace_all: z.boolean().optional().describe('Replace all occurrences (default false, requires unique match)'),
    }),
  },
  {
    name: 'grep_code',
    description:
      'Search file CONTENTS (regex or plain keyword) and return matching lines as "file:line:snippet". Use for locating where a function, field, URL or pattern appears across a codebase. IMPORTANT — always pass `path` (a specific repo/module directory such as "<repo>/your-backend-module" or "<repo>/src/pages/<route>") and pass `include` (e.g. "*.java", "*.xml", "*.vue"): searching a whole workspace (several repos, tens of thousands of files) is an order of magnitude slower and comes back truncated. Each call has a hard time budget; if the result says incomplete/truncated, do NOT repeat the same broad search — narrow `path`/`include` or use glob_files to locate the file by name first.',
    schema: z.object({
      pattern: z.string().describe('Regex pattern or plain keyword to search for'),
      path: z
        .string()
        .optional()
        .describe(
          'Directory to search in. ALWAYS set this to the specific repo/module directory. If omitted it defaults to the whole first allowed directory (very slow, easily truncated).'
        ),
      include: z
        .string()
        .optional()
        .describe('File name filter glob, e.g. "*.java", "*.xml", "*.vue". Strongly recommended — without it every text file in the tree gets read.'),
      max_results: z.number().int().min(1).max(100).optional().describe('Max results to return (default 30)'),
    }),
  },
  {
    name: 'glob_files',
    description:
      'Find files by glob pattern (supports **, *, ?). Pass `path` when the pattern does not already contain the directory part (e.g. path="<repo>/your-backend-module", pattern="**/*Collect*.java"). Cheapest way to locate a file: prefer this over grep_code when you are guessing a file name.',
    schema: z.object({
      pattern: z.string().describe('Glob pattern, e.g. "src/**/*.vue" or "*.ts"'),
      path: z.string().optional().describe('Root directory to search from (defaults to first allowed directory; set it to keep the scan small)'),
      max_results: z.number().int().min(1).max(200).optional().describe('Max files to return (default 50)'),
    }),
  },
  {
    name: 'update_todos',
    description:
      '创建 / 更新当前会话的任务清单（结构化 todo list）。**开工前用它把计划写下来**：当一个任务需要 3 步以上（读多个文件、改多个位置、改完要自检）时，先把步骤列成清单再动手，然后按清单推进 —— 这份清单会在**每一轮请求末尾回显给你**，所以它是"我做到哪了"的唯一事实来源，不要靠记忆推进。规则：① 整表覆盖 —— 每次传完整清单，不是增量；② status 只有 pending / in_progress / completed，**同时只允许一项 in_progress**；③ 只有真正做完（含验证）才标 completed，不要凭"打算做"就标；④ 清单变了就调一次，没变不要重复调用；⑤ **不要在做完后清空清单** —— 全部完成后直接给出最终回答，清单保留下去（用户会对着它核对你的结果）；只有用户明确要求清空、或整个计划作废时才传空数组 []。',
    schema: z.object({
      todos: z
        .array(
          z.object({
            text: z.string().describe('任务项文本，一句话说清要做什么（含关键文件路径更佳）'),
            status: z.enum(['pending', 'in_progress', 'completed']).describe('该项状态；同时最多一项为 in_progress'),
          })
        )
        .describe('完整清单（整表覆盖）。传空数组表示清空清单。'),
    }),
  },
  {
    name: 'list_skills',
    description: 'List all skill files in the skills directory',
    schema: z.object({}),
  },
  {
    name: 'read_skill',
    description: 'Read a skill file by name',
    schema: z.object({
      name: z.string().describe('Skill name (with or without .md extension)'),
    }),
  },
  {
    name: 'write_skill',
    description: 'Write a skill file. Stored in the skills directory.',
    schema: z.object({
      name: z.string().describe('Skill name (will use .md extension)'),
      content: z.string().describe('Content of the skill'),
    }),
  },
  {
    name: 'list_memories',
    description: 'List all memory files in the memory directory',
    schema: z.object({}),
  },
  {
    name: 'read_memory',
    description: 'Read a memory file by name',
    schema: z.object({
      name: z.string().describe('Memory name (with or without .md extension)'),
    }),
  },
  {
    name: 'write_memory',
    description: 'Write a memory file. Stored in the memory directory.',
    schema: z.object({
      name: z.string().describe('Memory name (will use .md extension)'),
      content: z.string().describe('Content of the memory'),
    }),
  },
  {
    name: 'search_web',
    description:
      'Search the internet for real-time information, news, weather, or current events. Use this when the user asks about recent events, weather, stock prices, or anything that requires up-to-date information.',
    schema: z.object({
      query: z.string().describe('The search query string'),
    }),
  },
  {
    name: 'search_history',
    description:
      '搜索用户的历史会话记录（会话标题 + 消息内容，大小写不敏感）。当用户问起"之前/上次/以前说过、做过、写过、生成过什么"，或需要回忆历史对话内容时使用。每个命中会话返回标题、匹配片段、命中次数和截断后的对话全文，可直接基于内容回答用户。可用 limit 控制返回条数。',
    schema: z.object({
      query: z.string().describe('要搜索的关键词，如"正则表达式"、"待办清单"、"日报"'),
      limit: z.number().int().min(1).max(10).optional().describe('最多返回的会话条数（默认 3，最大 10）'),
    }),
  },
  {
    name: 'execute_command',
    description:
      "Execute a shell command on the user's computer (via bash). Use this to run scripts, install packages, start servers, or perform any command-line task. The command runs in the CURRENT working directory — which persists between commands in the dev role — with a 300-second (5-minute) timeout. Do NOT prepend `cd <repo> &&` on every call: once you have cd'ed (or passed cwd), later commands start there. Pass `cwd` when you need to switch to another repo for one command. Long output is auto-truncated to head+tail (8 KB each) and the FULL output is saved to a local log file: when the result has stdoutTruncated:true, grep that stdoutPath file for the interesting lines (error / failed / FAIL) instead of re-running the command — never conclude 'build/test passed' from a truncated tail. Do NOT run whole-project type checks (vue-tsc --noEmit / tsc --noEmit) or full production builds as a verification step: they take minutes on large projects and the user runs them at packaging time. For self-check, use eslint + syntax/compile checks on the changed files only.",
    schema: z.object({
      command: z.string().describe('The shell command to execute'),
      cwd: z
        .string()
        .optional()
        .describe('Absolute directory to run this command in (defaults to the session working directory, which is remembered between calls). Use it instead of prefixing `cd <dir> &&`.'),
    }),
  },
  {
    name: 'browser_open',
    description:
      'Open the test browser and navigate to a URL. Use this for web page testing / web automation (测试网页、网页自动化、打开网站). Returns the page state { url, title, text, links }. Reuses the existing test window if already open.',
    schema: z.object({
      url: z.string().describe('The URL to open. Scheme optional (e.g. example.com → https://example.com).'),
      timeoutMs: z.number().optional().describe('Load timeout in milliseconds (default 10000).'),
    }),
  },
  {
    name: 'browser_click',
    description:
      'Click an element in the test page. Target is preferably the `ref` from browser_snapshot; a CSS selector (e.g. "button.primary", "#login") or exact text ("text=登录") also works. When the same text appears many times, use the explicit `ref`, or disambiguate with ">> nth=N" (0-based, e.g. "text=编辑 >> nth=57") — a bare "text=编辑" always hits the FIRST match. Scrolls the element into view and sends a real mouse click.',
    schema: z.object({
      selector: z.string().describe('`ref` from browser_snapshot (e.g. "ref=23"), a CSS selector, "text=ExactText", or "text=ExactText >> nth=N".'),
      timeoutMs: z.number().optional().describe('How long to wait for the element to appear (default 5000).'),
    }),
  },
  {
    name: 'browser_type',
    description:
      'Focus an input/textarea/contenteditable and type text (appends like real typing). Target uses the same forms as browser_click: a `ref` from browser_snapshot (preferred), a CSS selector, or "text=...".',
    schema: z.object({
      selector: z.string().describe('`ref` from browser_snapshot, a CSS selector, "text=ExactText", or "text=ExactText >> nth=N".'),
      text: z.string().describe('The text to type.'),
    }),
  },
  {
    name: 'browser_press',
    description:
      'Press a key or chord in the test page: "Enter", "Escape", "Tab", "Control+S", "Shift+Tab", "ArrowDown", "F5", etc.',
    schema: z.object({
      key: z.string().describe('Key or modifier chord, e.g. "Enter" or "Control+Shift+P".'),
    }),
  },
  {
    name: 'browser_eval',
    description:
      'Evaluate JavaScript in the test page context (sandboxed). `arg` is available as a local variable. Use for complex DOM reads, custom waits, or one-off actions. Use `return` to yield a value.',
    schema: z.object({
      js: z
        .string()
        .describe('JS function body, e.g. "return document.querySelectorAll(\'.item\').length" or "return [...document.querySelectorAll(\'a\')].map(a => a.href)".'),
      arg: anyObject().optional().describe('Optional payload available as the local variable `arg`.'),
    }),
  },
  {
    name: 'browser_get_page',
    description:
      'Read the current test page state: URL, title, visible text (truncated) and top links. Call this to read page body text / data / results.',
    schema: z.object({
      maxLen: z.number().optional().describe('Max text length to return (default 6000, max 20000).'),
    }),
  },
  {
    name: 'browser_snapshot',
    description:
      'Return a compact list of interactive elements on the test page (buttons / inputs / links / selects / checkboxes), each with a stable `ref`, `role` and `name` — no CSS selector noise, so it is far cheaper than browser_get_page. It also reports `total` (how many matching elements exist in all) and `duplicates` (names that appear more than once, e.g. {"编辑":400}), so a truncated list is never a silent surprise. Pass an item\'s `ref` to browser_click / browser_type. When a name is repeated, always use the explicit `ref` (a bare "text=编辑" resolves to the FIRST match) or disambiguate with "text=编辑 >> nth=57". Call it again after a large DOM change.',
    schema: z.object({
      max: z.number().optional().describe('Max elements to return (default 200, max 400).'),
    }),
  },
  {
    name: 'browser_wait_for',
    description:
      'Wait until an element is visible (pass selector) or a JS condition returns truthy (pass condition, use `return`). Use before interacting with dynamically-loaded content.',
    schema: z.object({
      selector: z.string().optional().describe('`ref` from browser_snapshot, a CSS selector, or "text=..." to wait for.'),
      condition: z.string().optional().describe('JS expression/body returning truthy when ready, e.g. "return window.__app && document.querySelector(\'.list\')".'),
      timeoutMs: z.number().optional().describe('Timeout in milliseconds (default 10000).'),
    }),
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the currently VISIBLE VIEWPORT of the test page as a PNG (not the whole scrollable page). The file is saved for the user to look at / keep as evidence, and — when the active model profile is vision-capable — the picture is also handed to you as an image, so you can look at it yourself. That makes it the fallback for visual things the DOM cannot describe (canvas drawings, CSS background images, layout overlap). Returns the saved path either way. Call it at most once per request.',
    schema: z.object({
      name: z.string().optional().describe('Screenshot file name (no extension).'),
    }),
  },
  {
    name: 'browser_read_images',
    description:
      'Grab the images of the currently open test page and hand them to you AS REAL IMAGES (vision) — banners, charts, screenshots-like blocks, layout, anything drawn in pictures. Use it whenever the user gives a web page URL (or asks "这个页面长什么样 / 图里写了什么 / 帮我看看这张图") — browser_get_page only returns text and cannot show you any picture. Returns a text index (alt / size / source URL) and attaches the images to your next message, so you can actually see them afterward. Requires browser_open first (it reads the CURRENT page). Always pick ≤3 unless you really need more. Only dispatched when the active model profile is marked vision-capable. For a document-like page (spec / PRD / wiki / online doc) the pictures are usually the substance — do not report on the page text alone; when the page has many images, look at the ones the text points at plus prototype/flow-chart/field-table pictures, and state honestly how many you looked at and which you skipped.',
    schema: z.object({
      max: z.number().int().min(1).max(4).optional().describe('Max images to attach (default 3, max 4). Each image costs ≈1.4k tokens at 1280px, and is re-sent every following round.'),
    }),
  },
  {
    name: 'browser_console_logs',
    description:
      'Read recent console messages from the test page (log/info/warning/error). Useful for debugging page errors during testing.',
    schema: z.object({
      limit: z.number().optional().describe('Max entries to return (default 50).'),
      type: z.string().optional().describe('Filter by level: log | info | warning | error | debug.'),
      clear: z.boolean().optional().describe('Drain the buffer after reading.'),
    }),
  },
  {
    name: 'browser_close',
    description: 'Close the test browser window. It will be re-created automatically on the next browser_open.',
    schema: z.object({}),
  },
  {
    name: 'browser_wait_download',
    description:
      'Wait for a file download triggered by the test browser window to finish (e.g. after clicking a website「下载」button). Downloads are auto-saved to the app download dir (userData/browser-downloads) without a system dialog; this tool returns the saved local file path + filename + state so you can read_file / execute_command it afterwards. Pass name (filename keyword) when multiple downloads may exist; call it right after the click and poll internally until done or timeout.',
    schema: z.object({
      name: z.string().optional().describe('Filename keyword to match (optional; latest download used when omitted).'),
      timeoutMs: z.number().int().min(2000).max(180000).optional().describe('Max wait in ms (default 60000).'),
    }),
  },
  {
    name: 'browser_flow',
    description:
      'Run a whole sequence of browser steps in ONE call — click / type / press / wait / goto / sleep / assert* — stopping at the first failure and returning a per-step pass/fail summary plus the page snapshot AT the point of failure. This is the fastest way to execute a known test flow: 20 steps cost 1 roundtrip instead of 40+. Step shape: { action, target?, value?, note? }. Actions: "click" (needs target), "type" (target + value), "press" (value = key, e.g. "Enter"), "wait" (target = selector, or value = ms), "goto" (value = url), "sleep" (value = ms), "assertText" (target + value = substring), "assertValue" (target + value = exact match), "assertVisible" (target), "assertUrl" (value = substring of current URL), "assertEval" (value = JS expression returning truthy). `target` accepts a `ref` from browser_snapshot (preferred), a CSS selector, or "text=..." (use "text=... >> nth=N" for repeated names). Pass `saveAs` to persist the flow as YAML — refs are automatically converted to stable selectors — and later replay it with zero LLM via `flow: "<name>"`.',
    schema: z.object({
      steps: z
        .array(
          z.object({
            action: z.string().describe('click / type / press / wait / goto / sleep / assertText / assertValue / assertVisible / assertUrl / assertEval'),
            target: z.string().optional().describe('Element target: `ref` from browser_snapshot, a CSS selector, or "text=ExactText" ("text=ExactText >> nth=N" for repeated names).'),
            value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Text to type / key to press / ms to wait / expected value for asserts.'),
            note: z.string().optional().describe('Free-form note, preserved in the saved YAML.'),
            timeoutMs: z.number().optional().describe('Per-step timeout override.'),
          }),
        )
        .optional()
        .describe('Steps to execute. Omit this when replaying a saved flow via `flow`.'),
      flow: z.string().optional().describe('Name of a previously saved flow (YAML) to replay with zero LLM. Alternative to `steps`.'),
      saveAs: z.string().optional().describe('Persist this flow under this name so it can be replayed later without the model.'),
      name: z.string().optional().describe('Human-readable flow name, written into the saved YAML.'),
      stopOnFail: z.boolean().optional().describe('Stop at the first failing step (default true).'),
    }),
  },
  {
    name: 'ask_user',
    description:
      '在回答之前向用户提一个关键问题或一组选择题，应用会在聊天区弹出选择卡片，等待用户选择/输入后把回答作为工具结果返回给你。用于：① 用户需求的目标、范围、关键信息不清楚时；② 需要在多个方案/方向间让用户拍板时；③ 预判继续深入阅读代码或资料会比较慢，先让用户缩小范围或确认关键点时。注意：问题要短、有推进价值；能推断的先给出你的判断让用户确认，不要把所有问题都推回给用户；不要连续反问超过 3 次，用户回答后基于已有信息推进，未确认项标记为"待确认"。',
    schema: z.object({
      question: z.string().trim().min(1).describe('要问用户的问题，简短明确'),
      options: z.array(z.string()).max(6).optional().describe('给用户的选择项（最多 6 个）。不传则只有开放式输入框。注意：无论传不传，弹窗下方**始终**有自定义输入栏、用户可忽略选项自己写 —— 不需要为了"留个自由发挥的余地"而额外加一个"其他"选项。'),
    }),
  },
  {
    name: 'legal_npc_search',
    description:
      '在国家法律法规数据库（https://flk.npc.gov.cn/，全国人大官网）检索公开法律法规，返回命中列表（标题/公布与施行日期/制定机关/法规位阶/时效性编码 sxx/法规ID bbbs）。实现为官网纯 HTTP 检索接口（无需打开浏览器、无验证码），适用于用户要求某法规/条例全文或具体内容、而本地法律法规库中缺失时；官网收录宪法、法律、行政法规、监察法规及省/设区市地方性法规。拿到 bbbs 后配合 download_url 下载文字版 docx：url=https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs=<法规ID>。仅当接口被网络/WAF 拦截时工具内部才自动回退浏览器站内搜索。禁止不经检索就凭模型知识直接作答或只列推荐网站；同名多版本命中时优先 sxx 对应「现行有效」且公布日期最新者；地方性法规未命中可再用 search_web 找当地人大/政府公报官方原文。内部合同、公司制度等涉密材料一律禁止调用。',
    schema: z.object({
      query: z.string().describe('检索内容：法规/条例全称（优先）、关键词、发文字号 等，如 "杭州市民用建筑节能条例" 或 "建筑节能条例"'),
      page: z.number().int().min(1).max(50).optional().describe('结果页码（默认 1）'),
    }),
  },
  {
    name: 'download_url',
    description:
      '从官方直链下载文件到本地（浏览器下载目录 userData/browser-downloads，AI 可读可解析）。两类用途：① 国家法律法规数据库下载接口：https://flk.npc.gov.cn/law-search/download/pc?format=docx&bbbs=<法规ID>（format 用 docx 文字版优先；bbbs 由 legal_npc_search 返回的「法规 ID」字段或 flk 详情 URL 的 id= 提供）——工具会自动解析该接口返回的 JSON 并下载其签名直链，无需浏览器；② 政府公报 / 地方人大等官方附件直链（域名限 *.gov.cn / *.npc.gov.cn）。保存成功后返回本地绝对路径 file，之后用 read_file / execute_command 解析内容（docx 可解 zip 读 word/document.xml，或经 python-docx / LibreOffice 转文本）。禁止下载非官方域（防 SSRF）。',
    schema: z.object({
      url: z.string().describe('官方直链或 flk 下载接口 URL（http/https，域名 *.gov.cn / *.npc.gov.cn）'),
      name: z.string().optional().describe('保存文件名（含扩展名，如 "民用建筑节能条例.docx"）；不传则按直链自动推断'),
    }),
  },
  // ---- Sub-Agent tools (defined in tool-schemas-subagent.js) ----
  ...SUB_AGENT_TOOLS,
]

// ============================================================
//  工具定义（发给模型的 OpenAI function tools）—— 由 zod schema 自动派生，
//  避免手写静态 schema 漏字段/写错类型。请求体与上下文 token 估算共用。
// ============================================================
const TOOLS_DEFINITION = TOOLS.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: zodToJsonSchema(t.schema),
  },
}))

module.exports = { TOOLS, TOOLS_DEFINITION, zodToJsonSchema }
