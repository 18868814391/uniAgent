import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve, relative } from 'path'
import { readdirSync, statSync, copyFileSync, mkdirSync, existsSync } from 'fs'

/**
 * vite-plugin-electron 把主进程构建为 CJS，且把内部相对 require 当作"运行时文件系统依赖"
 * 来引用（产物为 require("./settings") 等），并不会自动把这些新拆出的领域模块打进输出目录。
 * 因此构建/开发完成后，把 electron/ 源码里尚未作为独立入口（builtin entries）的 .js
 * 原样复制到 dist-electron/ —— 它们都是纯 CJS，与插入 require 的产物等效，运行时可直接解析。
 */
function copyElectronModules() {
  // vite-plugin-electron 已作为独立入口构建过的文件：保留其产物，不覆盖
  const BUILTIN_ENTRIES = new Set([
    'main.js', 'preload.js', 'browser-test.js', 'tool-schemas.js', 'net-retry.js',
  ])
  const SRC = resolve(__dirname, 'electron')
  const OUT = resolve(__dirname, 'dist-electron')

  function copyDir(srcdir, outdir, baseDir) {
    if (!existsSync(srcdir)) return
    mkdirSync(outdir, { recursive: true })
    for (const name of readdirSync(srcdir)) {
      const src = resolve(srcdir, name)
      const st = statSync(src)
      if (st.isDirectory()) {
        copyDir(src, resolve(outdir, name), baseDir)
        continue
      }
      if (!name.endsWith('.js')) continue
      // 顶层已作为入口构建的文件保留其产物（否则源码复制覆盖产物，虽等效但属冗余）
      if (relative(baseDir, src).replace(/\\/g, '/') === name && BUILTIN_ENTRIES.has(name)) continue
      // 跳过已知的临时冒烟/调试文件，避免污染输出目录
      if (name === 'simple-test.js' || name === 'test-electron.js') continue
      copyFileSync(src, resolve(outdir, name))
    }
  }
  copyDir(SRC, OUT, SRC)
}

export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        entry: 'electron/main.js',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.js',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
      {
        entry: 'electron/browser-test.js',
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
      {
        entry: 'electron/tool-schemas.js',
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
      {
        entry: 'electron/net-retry.js',
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    // 构建结束（含 electron 各入口）后复制新增源码模块到 dist-electron/
    {
      name: 'copy-electron-modules',
      closeBundle() {
        copyElectronModules()
      },
    },
    renderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
