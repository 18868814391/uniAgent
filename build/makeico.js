const fs = require('fs')
const path = require('path')
const jpeg = require('jpeg-js')

const SRC = 'C:/Users/syf/Desktop/图片目录/htlogo.jpg'
const OUT = 'C:/Users/syf/Desktop/mes/localAi/build/icon.ico'

function decodeRGBA(src) {
  const raw = fs.readFileSync(src)
  const r = jpeg.decode(raw, { useTArray: true, maxMemoryUsageInMB: 200 })
  return { width: r.width, height: r.height, data: r.data }
}

function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  const sxRatio = sw / dw, syRatio = sh / dh
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * syRatio))
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(x * sxRatio))
      const si = (sy * sw + sx) * 4, di = (y * dw + x) * 4
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3]
    }
  }
  return out
}

// 32-bit BMP icon (BGRA, bottom-up) with AND mask (all-zero = fully opaque)
function bmpIcon(width, height, rgba) {
  const xor = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4, dstRow = y * width * 4
    for (let x = 0; x < width; x++) {
      const si = srcRow + x * 4, di = dstRow + x * 4
      xor[di] = rgba[si + 2]; xor[di + 1] = rgba[si + 1]; xor[di + 2] = rgba[si]; xor[di + 3] = rgba[si + 3]
    }
  }
  const andRowBytes = Math.ceil(width / 32) * 4
  const and = Buffer.alloc(andRowBytes * height, 0)
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)        // biSize
  header.writeInt32LE(width, 4)      // biWidth
  header.writeInt32LE(height * 2, 8) // biHeight = XOR + AND (ICO convention)
  header.writeUInt16LE(1, 12)        // planes
  header.writeUInt16LE(32, 14)       // bit count
  header.writeUInt32LE(0, 16)        // BI_RGB
  header.writeUInt32LE(xor.length, 20) // biSizeImage = XOR only
  return Buffer.concat([header, xor, and])
}

const src = decodeRGBA(SRC)
const sizes = [16, 24, 32, 48, 64, 128, 256]
const dibs = sizes.map(s => bmpIcon(s, s, resample(src.data, src.width, src.height, s, s)))

const ICONDIR = 6, ENTRY = 16
const dir = Buffer.alloc(ICONDIR + ENTRY * sizes.length)
dir.writeUInt16LE(0, 0)
dir.writeUInt16LE(1, 2)
dir.writeUInt16LE(sizes.length, 4)

let offset = ICONDIR + ENTRY * sizes.length
sizes.forEach((s, i) => {
  const dib = dibs[i]
  const e = Buffer.alloc(ENTRY)
  const wb = s >= 256 ? 0 : s
  e.writeUInt8(wb, 0)
  e.writeUInt8(wb, 1)
  e.writeUInt8(0, 2)
  e.writeUInt8(0, 3)
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(dib.length, 8)
  e.writeUInt32LE(offset, 12)
  e.copy(dir, ICONDIR + ENTRY * i) // 注意方向：把 e 拷进 dir
  offset += dib.length
})

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, Buffer.concat([dir, ...dibs]))
console.log('written', OUT, fs.statSync(OUT).size)
