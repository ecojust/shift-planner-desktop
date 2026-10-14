import { MAX_AVATAR_LENGTH } from './avatarData.ts'

export const MAX_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024
export const MAX_AVATAR_DATA_URL_LENGTH = MAX_AVATAR_LENGTH
const MAX_PIXELS = 40_000_000
const MAX_EDGE = 16_384

function checkDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('图片尺寸无效，请重新选择。')
  if (width * height > MAX_PIXELS || width > MAX_EDGE || height > MAX_EDGE) throw new Error('图片过大，请选择不超过 4000 万像素、边长不超过 16384 像素的图片。')
}

// Read the entire bounded source so JPEG metadata cannot hide an oversized
// frame beyond a partial read. Missing / unsupported dimensions fail closed.
async function checkHeaderDimensions(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  const invalid = () => new Error('无法读取图片尺寸，请选择完整有效的 JPG、PNG 或 WebP 文件。')
  if (bytes.length >= 33 && bytes[0] === 137 && tag(1) === 'PNG\r' && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 && view.getUint32(8) === 13 && tag(12) === 'IHDR') {
    checkDimensions(view.getUint32(16), view.getUint32(20)); return
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2, foundFrame = false
    const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) throw invalid()
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]!
      if (marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      if (offset + 2 > bytes.length) break
      const size = view.getUint16(offset)
      if (size < 2 || offset + size > bytes.length) break
      if (frameMarkers.has(marker)) {
        if (size < 8) throw invalid()
        checkDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3)); foundFrame = true
      }
      if (marker === 0xda) { if (foundFrame) return; throw invalid() }
      offset += size
    }
    throw invalid()
  }
  if (bytes.length >= 30 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    const end = view.getUint32(4, true) + 8
    if (end > bytes.length || end < 30) throw invalid()
    let offset = 12, foundFrame = false
    while (offset + 8 <= end) {
      const kind = tag(offset), size = view.getUint32(offset + 4, true), data = offset + 8
      if (data + size > end) throw invalid()
      if (kind === 'VP8X' && size >= 10) {
        checkDimensions(1 + bytes[data + 4]! + (bytes[data + 5]! << 8) + (bytes[data + 6]! << 16), 1 + bytes[data + 7]! + (bytes[data + 8]! << 8) + (bytes[data + 9]! << 16)); foundFrame = true
      } else if (kind === 'VP8L' && size >= 5 && bytes[data] === 0x2f) {
        checkDimensions(1 + bytes[data + 1]! + ((bytes[data + 2]! & 0x3f) << 8), 1 + (bytes[data + 2]! >> 6) + (bytes[data + 3]! << 2) + ((bytes[data + 4]! & 0xf) << 10)); foundFrame = true
      } else if (kind === 'VP8 ' && size >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
        checkDimensions(view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff); foundFrame = true
      }
      offset = data + size + size % 2
    }
    if (foundFrame) return
  }
  throw invalid()
}

/** Produces a bounded JPEG thumbnail; original file bytes and metadata are never stored. */
export async function createAvatarThumbnail(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。')
  if (!file.size || file.size > MAX_AVATAR_SOURCE_BYTES) throw new Error('图片文件需大于 0 且不超过 10 MB。')
  await checkHeaderDimensions(file)
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }) }
  catch { throw new Error('无法读取这张图片，请选择完整有效的 JPG、PNG 或 WebP 文件。') }
  const canvas = document.createElement('canvas')
  try {
    checkDimensions(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('当前环境无法处理图片，请换一张图片或稍后重试。')
    const crop = Math.min(bitmap.width, bitmap.height)
    for (const size of [96, 80, 64, 48]) {
      canvas.width = size; canvas.height = size
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, size, size)
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'
      context.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, size, size)
      for (const quality of [0.86, 0.72, 0.58, 0.42]) {
        const result = canvas.toDataURL('image/jpeg', quality)
        if (result.startsWith('data:image/jpeg;base64,') && result.length <= MAX_AVATAR_DATA_URL_LENGTH) return result
      }
    }
    throw new Error('图片压缩后仍然过大，请换一张较简单的图片。')
  } finally { bitmap.close(); canvas.width = 0; canvas.height = 0 }
}
