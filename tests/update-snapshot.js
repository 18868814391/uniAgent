// 重新生成 tests/fixtures/tools-definition.snapshot.json
// 用法：node tests/update-snapshot.js
// 当有意调整工具 schema 时运行，让快照与当前 zod 派生结果一致。
const fs = require('node:fs')
const path = require('node:path')
const { TOOLS, zodToJsonSchema } = require('../electron/tool-schemas.js')

const generated = TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.schema) },
}))
const target = path.join(__dirname, 'fixtures', 'tools-definition.snapshot.json')
fs.writeFileSync(target, JSON.stringify(generated, null, 2) + '\n', 'utf-8')
console.log(`快照已更新：${target}（${generated.length} 个工具）`)
