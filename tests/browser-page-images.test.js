// 页面侧「取图脚本」的回归测试（2026-10-05，与 browser_read_images 同批）
//
// 为什么必须单独测：这段 JS 是一段**模板字符串**（browser-test.js 的 buildImageCollectScript），
// `node --check` 只校验外层字面量、**不会**校验里面的 JS；而它在页面上下文里执行，
// safeEval 的 catch 会把异常吃掉 —— 里面有语法错/逻辑错，表现只是
// 「页面里没有找到符合条件的图片」，既没有报错也没有日志，排查时完全看不出是代码坏了。
//
// 所以这里用**假 DOM**（不用 Electron、不用真浏览器）直接跑那段脚本，锁住 6 条：
//   1) 脚本能被 new Function 编译（语法层）
//   2) 小图标 / tracking pixel / data: 内联图 / 非 http(s) 一律不进候选
//   3) 懒加载图按 data-src、srcset 取真实地址
//   4) 去重（同一张图出现多次只算一次）
//   5) 排序：视口内优先 → 渲染面积降序；LIMIT 生效但 count 报的是过滤后总数
//   6) og:image 兜底（页面没有 <img> 时唯一来源）
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')

const ELECTRON = path.join(__dirname, '..', 'electron')

const stub = (request, exports) => {
  const id = require.resolve(request, { paths: [ELECTRON] })
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
stub('electron', { app: { getPath: () => os.tmpdir() }, BrowserWindow: function BrowserWindow() {} })
stub('./settings', { getBrowserDownloadsDir: () => os.tmpdir(), getTestOutputDir: () => os.tmpdir() })
// browser-test 现在引用 fs-safe 的图片编码器；这里只测页面侧脚本，编码器给个壳即可
stub('./tools/fs-safe', { imagePartFromBuffer: () => null, MAX_IMAGE_BYTES: 10 * 1024 * 1024 })

const bt = require(path.join(ELECTRON, 'browser-test.js'))

// ---- 假 DOM ----
function fakeImg({ src, dataSrc, srcset, alt, w, h, top, currentSrc } = {}) {
  const attrs = {
    'data-src': dataSrc,
    'data-original': undefined,
    'data-lazy-src': undefined,
    srcset,
    'data-srcset': undefined,
    alt,
    title: undefined,
  }
  return {
    currentSrc: currentSrc || '',
    src: src || '',
    naturalWidth: w || 0,
    naturalHeight: h || 0,
    getBoundingClientRect: () => ({ width: w || 0, height: h || 0, top: top || 0 }),
    getAttribute: (k) => (k in attrs && attrs[k] !== undefined ? attrs[k] : null),
  }
}
function fakeMeta(content) {
  return { getAttribute: (k) => (k === 'content' ? content : null) }
}

function runScript(limit, { imgs = [], metas = [], innerHeight = 800, href = 'https://demo.local/list', title = '列表页' } = {}) {
  const script = bt.buildImageCollectScript(limit)
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'location', 'URL', `return ${script}`)
  const document = {
    baseURI: href,
    title,
    querySelectorAll: (sel) => (sel.indexOf('meta') === 0 ? metas : imgs),
  }
  return fn({ innerHeight }, document, { href }, URL)
}

test('取图脚本能被编译（模板字符串里的 JS 语法错只会静默失败，必须先兜住）', () => {
  assert.equal(typeof bt.buildImageCollectScript, 'function', '必须导出脚本构造器，否则本测试没法测真东西')
  const script = bt.buildImageCollectScript(3)
  assert.doesNotThrow(() => new Function(`return ${script}`))
  assert.match(script, /querySelectorAll\('img'\)/)
})

test('过滤：小图标、面积过小的细长条、data: 内联图、非 http(s) 一律不进候选', () => {
  const out = runScript(5, {
    imgs: [
      fakeImg({ src: '/main.png', alt: '主图', w: 800, h: 600, top: 100 }),
      fakeImg({ src: '/icon.png', alt: '图标', w: 16, h: 16, top: 0 }),          // 边长不足
      fakeImg({ src: '/pixel.png', alt: '埋点', w: 1, h: 1, top: 0 }),           // tracking pixel
      fakeImg({ src: '/banner.png', alt: '细长条', w: 600, h: 4, top: 0 }),      // 面积不足
      fakeImg({ src: 'data:image/png;base64,AAAA', alt: '内联', w: 400, h: 300 }), // data: 不收
      fakeImg({ src: 'blob:https://demo.local/xx', alt: 'blob', w: 400, h: 300 }), // 非 http(s)
    ],
  })
  assert.deepEqual(out.images.map((i) => i.url), ['https://demo.local/main.png'])
  assert.equal(out.count, 1, 'count 是过滤后的候选总数')
})

test('懒加载与 srcset：currentSrc 为空时按 data-src / srcset 取真实地址', () => {
  const out = runScript(5, {
    imgs: [
      fakeImg({ dataSrc: '/lazy.png', alt: '懒加载', w: 600, h: 400, top: 200 }),
      fakeImg({ srcset: '/a.png 1x, /a@2x.png 2x', alt: '响应式', w: 500, h: 300, top: 300 }),
      fakeImg({ src: '/loaded.png', currentSrc: '/loaded-2x.png', alt: '已加载', w: 500, h: 300, top: 400 }),
    ],
  })
  const urls = out.images.map((i) => i.url)
  assert.ok(urls.includes('https://demo.local/lazy.png'), 'data-src 必须被采纳（否则"还没滚到"的图全丢）')
  assert.ok(urls.includes('https://demo.local/a.png'), 'srcset 取第一个候选')
  assert.ok(urls.includes('https://demo.local/loaded-2x.png'), 'currentSrc 优先（浏览器实际选择的那张）')
  assert.equal(urls.filter((u) => u.includes('a@2x')).length, 0)
})

test('去重 + 排序：同一张图只算一次；视口内优先，其次渲染面积降序', () => {
  const out = runScript(5, {
    innerHeight: 800,
    imgs: [
      fakeImg({ src: '/small-inview.png', alt: '小·视口内', w: 100, h: 100, top: 600 }),
      fakeImg({ src: '/big-below.png', alt: '大·视口外', w: 1200, h: 900, top: 4200 }),
      fakeImg({ src: '/big-inview.png', alt: '大·视口内', w: 900, h: 700, top: 50 }),
      fakeImg({ src: '/big-inview.png', alt: '重复', w: 900, h: 700, top: 50 }),   // 与上一条同图
    ],
  })
  assert.equal(out.count, 3, '重复的 URL 只保留一次')
  assert.deepEqual(
    out.images.map((i) => i.url),
    ['https://demo.local/big-inview.png', 'https://demo.local/small-inview.png', 'https://demo.local/big-below.png'],
    '顺序应为：视口内面积大 → 视口内面积小 → 视口外（即便它更大）',
  )
})

test('LIMIT 生效，但 count 仍报过滤后的总数（便于告诉模型"还有更多"）', () => {
  const imgs = Array.from({ length: 9 }, (_, i) => fakeImg({ src: `/p${i}.png`, w: 600, h: 400, top: 100 + i }))
  const out = runScript(3, { imgs })
  assert.equal(out.images.length, 3)
  assert.equal(out.count, 9)
})

test('页面没有 <img> 时，og:image 是唯一来源；alt 折叠空白并截断', () => {
  const out = runScript(3, { metas: [fakeMeta('/og.png')] })
  assert.equal(out.images.length, 1)
  assert.equal(out.images[0].url, 'https://demo.local/og.png')
  assert.equal(out.images[0].source, 'meta')

  const long = runScript(3, { imgs: [fakeImg({ src: '/x.png', alt: `  ${'长'.repeat(200)}\n 未收敛 `, w: 600, h: 400 })] })
  const alt = long.images[0].alt
  assert.equal(alt.length, 120, 'alt 要截断（否则会被模型当成正文烧 token）')
  assert.equal(/\s{2,}/.test(alt), false, '空白要折叠（alt 里常带换行/缩进）')
})
