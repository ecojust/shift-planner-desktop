import test from 'node:test'
import assert from 'node:assert/strict'
import { createAvatarThumbnail, MAX_AVATAR_SOURCE_BYTES } from '../avatar.ts'

function decoderSpy(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  let calls = 0
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { calls++; throw new Error('decoder spy') } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'createImageBitmap', original); else delete globalThis.createImageBitmap })
  return () => calls
}
function jpeg(width, height, metadataChunks = 0) {
  const metadata = Array.from({ length: metadataChunks }, () => {
    const segment = Buffer.alloc(65537); segment[0] = 255; segment[1] = 225; segment.writeUInt16BE(65535, 2); return segment
  })
  const frame = Buffer.alloc(13)
  frame[0] = 255; frame[1] = 192; frame.writeUInt16BE(11, 2); frame[4] = 8
  frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7); frame[9] = 1; frame[10] = 1; frame[11] = 17
  const scan = Buffer.from([255, 218, 0, 8, 1, 1, 0, 0, 63, 0])
  return new File([Buffer.concat([Buffer.from([255, 216]), ...metadata, frame, scan, Buffer.from([0, 255, 217])])], 'photo.jpg', { type: 'image/jpeg' })
}
function png(width, height) {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return new File([bytes], 'photo.png', { type: 'image/png' })
}
function webp(chunks) {
  const payload = Buffer.concat(chunks.map(([name, bytes]) => {
    const header = Buffer.alloc(8); header.write(name); header.writeUInt32LE(bytes.length, 4)
    return Buffer.concat([header, bytes, Buffer.alloc(bytes.length % 2)])
  }))
  const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(payload.length + 4, 4); header.write('WEBP', 8)
  return new File([header, payload], 'photo.webp', { type: 'image/webp' })
}

test('JPEG dimensions after more than 1 MiB metadata are checked before decoding', async t => {
  const calls = decoderSpy(t), file = jpeg(20000, 20000, 17)
  assert.ok(file.size > 1024 * 1024 && file.size < MAX_AVATAR_SOURCE_BYTES)
  await assert.rejects(createAvatarThumbnail(file), /图片过大/)
  assert.equal(calls(), 0)
})

test('bounded valid JPEG dimensions remain supported after long metadata', async t => {
  const calls = decoderSpy(t)
  await assert.rejects(createAvatarThumbnail(jpeg(96, 128, 17)), /无法读取这张图片/)
  assert.equal(calls(), 1, 'the dimensions gate must allow normal JPEGs with long metadata')
})

test('missing or malformed supported dimensions fail before any image decoding', async t => {
  const calls = decoderSpy(t)
  const files = [
    new File([Buffer.from([255, 216, 255, 218, 0, 4, 0, 0])], 'missing.jpg', { type: 'image/jpeg' }),
    new File([Buffer.alloc(40)], 'broken.png', { type: 'image/png' }),
    webp([['JUNK', Buffer.alloc(16)]]),
  ]
  for (const file of files) await assert.rejects(createAvatarThumbnail(file), /无法读取图片尺寸/)
  assert.equal(calls(), 0)
})

test('PNG zero dimensions, oversized edges and excess pixel counts fail before decoding', async t => {
  const calls = decoderSpy(t)
  for (const [width, height] of [[0, 96], [17000, 1], [10000, 5000]]) await assert.rejects(createAvatarThumbnail(png(width, height)), /图片尺寸无效|图片过大/)
  assert.equal(calls(), 0)
})

test('small PNG headers are allowed through the dimensions gate', async t => {
  const calls = decoderSpy(t)
  await assert.rejects(createAvatarThumbnail(png(96, 128)), /无法读取这张图片/)
  assert.equal(calls(), 1)
})

test('WebP scans every dimensions chunk instead of trusting an earlier small canvas', async t => {
  const calls = decoderSpy(t), canvas = Buffer.alloc(10), frame = Buffer.alloc(10)
  canvas[4] = 95; canvas[7] = 95
  frame[3] = 0x9d; frame[4] = 1; frame[5] = 0x2a; frame.writeUInt16LE(10000, 6); frame.writeUInt16LE(5000, 8)
  await assert.rejects(createAvatarThumbnail(webp([['VP8X', canvas], ['JUNK', Buffer.alloc(4)], ['VP8 ', frame]])), /图片过大/)
  assert.equal(calls(), 0)
})

test('normal WebP lossy, lossless and extended headers remain supported', async t => {
  const calls = decoderSpy(t), lossy = Buffer.alloc(10), lossless = Buffer.alloc(10), extended = Buffer.alloc(10)
  lossy[3] = 0x9d; lossy[4] = 1; lossy[5] = 0x2a; lossy.writeUInt16LE(96, 6); lossy.writeUInt16LE(128, 8)
  lossless[0] = 0x2f; lossless[1] = 95; lossless[2] = 0xc0; lossless[3] = 31
  extended[4] = 95; extended[7] = 127
  for (const chunk of [['VP8 ', lossy], ['VP8L', lossless], ['VP8X', extended]]) await assert.rejects(createAvatarThumbnail(webp([chunk])), /无法读取这张图片/)
  assert.equal(calls(), 3)
})

test('oversized source and unsupported MIME types are rejected without decoding', async t => {
  const calls = decoderSpy(t)
  await assert.rejects(createAvatarThumbnail(new File([Buffer.alloc(MAX_AVATAR_SOURCE_BYTES + 1)], 'huge.jpg', { type: 'image/jpeg' })), /10 MB/)
  await assert.rejects(createAvatarThumbnail(new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' })), /JPG、PNG 或 WebP/)
  assert.equal(calls(), 0)
})
