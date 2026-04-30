'use strict'
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

function createCirclePNG(size) {
  const cx = size / 2, cy = size / 2, r = size * 0.35
  // RGBA pixel data
  const pixels = Buffer.alloc(size * size * 4, 0)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * size + x) * 4
        pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 255
      }
    }
  }
  // Build PNG raw data (filter byte 0 per row)
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0  // filter: none
    pixels.copy(row, 1, y * size * 4, (y + 1) * size * 4)
    rows.push(row)
  }
  const raw = Buffer.concat(rows)
  const compressed = zlib.deflateSync(raw)

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const typeB = Buffer.from(type)
    const crc = crc32(Buffer.concat([typeB, data]))
    const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc >>> 0)
    return Buffer.concat([len, typeB, data, crcB])
  }

  function crc32(buf) {
    let c = 0xFFFFFFFF
    const t = []
    for (let n = 0; n < 256; n++) {
      let k = n
      for (let j = 0; j < 8; j++) k = (k & 1) ? (0xEDB88320 ^ (k >>> 1)) : (k >>> 1)
      t[n] = k
    }
    for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ])
}

fs.mkdirSync(path.join(__dirname, '../assets'), { recursive: true })
fs.writeFileSync(path.join(__dirname, '../assets/trayTemplate.png'), createCirclePNG(16))
fs.writeFileSync(path.join(__dirname, '../assets/trayTemplate@2x.png'), createCirclePNG(32))
console.log('Icons created.')
