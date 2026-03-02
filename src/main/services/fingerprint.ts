import { createHash } from 'crypto'
import { open, stat } from 'fs/promises'
import { FINGERPRINT_SAMPLE_SIZE } from '../../shared/protocol'
import type { FileFingerprint } from '../../shared/types'
import { basename } from 'path'

/**
 * Sampled SHA-256: reads first 4MB + middle 4MB + last 4MB of the file,
 * combined with the file size, to produce a fast but reliable fingerprint.
 * Video duration is obtained separately via mpv.
 */
export async function computeFingerprint(
  filePath: string,
  duration: number
): Promise<FileFingerprint> {
  const fileStat = await stat(filePath)
  const fileSize = fileStat.size
  const hash = createHash('sha256')

  const fd = await open(filePath, 'r')
  try {
    const chunkSize = FINGERPRINT_SAMPLE_SIZE
    const buf = Buffer.alloc(chunkSize)

    // Head chunk
    const headRead = await fd.read(buf, 0, chunkSize, 0)
    hash.update(buf.subarray(0, headRead.bytesRead))

    // Middle chunk
    if (fileSize > chunkSize * 2) {
      const midOffset = Math.floor((fileSize - chunkSize) / 2)
      const midRead = await fd.read(buf, 0, chunkSize, midOffset)
      hash.update(buf.subarray(0, midRead.bytesRead))
    }

    // Tail chunk
    if (fileSize > chunkSize) {
      const tailOffset = Math.max(0, fileSize - chunkSize)
      const tailRead = await fd.read(buf, 0, chunkSize, tailOffset)
      hash.update(buf.subarray(0, tailRead.bytesRead))
    }

    // Include file size in hash for extra safety
    hash.update(Buffer.from(fileSize.toString()))

    return {
      hash: hash.digest('hex'),
      size: fileSize,
      duration,
      fileName: basename(filePath)
    }
  } finally {
    await fd.close()
  }
}

export function fingerprintsMatch(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.hash === b.hash && a.size === b.size
}
