'use strict'
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

// Two opposing arrows suggesting P2P sync  →  ←
// 1 = black pixel, 0 = transparent
const ICON_16 = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0],
  [0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
]

function scaleTo32(grid16) {
  const grid32 = []
  for (const row of grid16) {
    const r = row.flatMap(v => [v, v])
    grid32.push(r)
    grid32.push(r)
  }
  return grid32
}

function createPNG(grid) {
  const size = grid.length
  const pixels = Buffer.alloc(size * size * 4, 0)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (grid[y][x]) {
        const i = (y * size + x) * 4
        pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0; pixels[i+3] = 255
      }
    }
  }

  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0
    pixels.copy(row, 1, y * size * 4, (y + 1) * size * 4)
    rows.push(row)
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows))

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

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const typeB = Buffer.from(type)
    const crc = crc32(Buffer.concat([typeB, data]))
    const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc >>> 0)
    return Buffer.concat([len, typeB, data, crcB])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ])
}

fs.mkdirSync(path.join(__dirname, '../assets'), { recursive: true })
fs.writeFileSync(path.join(__dirname, '../assets/trayTemplate.png'), createPNG(ICON_16))
fs.writeFileSync(path.join(__dirname, '../assets/trayTemplate@2x.png'), createPNG(scaleTo32(ICON_16)))
console.log('Icons created.')
