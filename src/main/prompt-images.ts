import { nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { workspacePath } from './agent-artifacts'
import type { ContextAttachment } from '../shared/structured-agent'

/** The longest edge Anthropic recommends; larger images are scaled down on its side anyway. */
export const MESSAGE_IMAGE_EDGE = 1568

/**
 * Re-encodes one image so it fits `maxBytes`: scaled to at most MESSAGE_IMAGE_EDGE on its long edge,
 * as JPEG, with the quality and then the size stepped down until it fits. Null when it cannot be
 * decoded here (no Electron, as in unit tests) or would have to shrink below legibility.
 *
 * This is what lets a message carry several phone photos: each is stored at up to 2 MiB, which is
 * ~2.7 MiB once base64-encoded, so three of them used to exceed the Claude message budget and the
 * send was refused after the owner had already pressed it (haf-stuff, 2026-10-21).
 */
export function fitImageForMessage(bytes: Buffer, maxBytes: number): Buffer | null {
  if (typeof nativeImage?.createFromBuffer !== 'function' || maxBytes < 16 * 1024) return null
  let image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (!width || !height) return null
  if (Math.max(width, height) > MESSAGE_IMAGE_EDGE) image = image.resize(width >= height ? { width: MESSAGE_IMAGE_EDGE, quality: 'best' } : { height: MESSAGE_IMAGE_EDGE, quality: 'best' })
  let quality = 85
  let encoded = image.toJPEG(quality)
  while (encoded.length > maxBytes) {
    if (quality > 60) quality -= 10
    else {
      const size = image.getSize()
      if (Math.max(size.width, size.height) < 400) return null
      image = image.resize({ width: Math.round(size.width * 0.8), quality: 'best' })
    }
    encoded = image.toJPEG(quality)
  }
  return encoded
}

/** Checks and shrinks pasted image bytes to a PNG or JPEG of at most `maxBytes`. Used on its own
 *  by a controlling machine before it sends an image to the machine whose project it belongs to. */
export function encodePromptImage(input: unknown, maxBytes = 2 * 1024 * 1024): { bytes: Buffer; extension: 'png' | 'jpg' } {
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > 20 * 1024 * 1024) throw new Error('Choose an image no larger than 20 MB')
  const bytes = Buffer.from(input)
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const gif = /^GIF8[79]a$/.test(bytes.subarray(0,6).toString())
  const webp = bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP'
  if (!png && !jpeg && !gif && !webp) throw new Error('Choose a PNG, JPEG, GIF or WebP image')
  let image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) throw new Error('This image could not be decoded')
  let { width, height } = image.getSize()
  if (!width || !height || width * height > 80_000_000) throw new Error('Image dimensions are too large')
  if (Math.max(width,height) > 4096) image = image.resize(width >= height ? {width:4096} : {height:4096})
  let encoded = image.toPNG()
  let extension: 'png' | 'jpg' = 'png'
  if (encoded.length > maxBytes) { encoded = image.toJPEG(90); extension = 'jpg' }
  while (encoded.length > maxBytes) {
    ;({width,height} = image.getSize())
    if (Math.max(width,height) < 512) throw new Error('Image could not be prepared within the attachment limit')
    image = image.resize({width:Math.round(width*.75)})
    encoded = image.toJPEG(85)
  }
  return { bytes: encoded, extension }
}

/** Uploaded bytes become immutable workspace images, so providers and restored drafts share them. */
export async function importPromptImage(cwd: string, name: unknown, input: unknown): Promise<ContextAttachment> {
  if (typeof name !== 'string') throw new Error('Name the image')
  const { bytes: encoded, extension } = encodePromptImage(input)
  // Validate each ancestor separately; never follow a user-created junction out of the project.
  for (const part of ['.conductor', '.conductor/prompt-images']) {
    const directory = await workspacePath(cwd,part,true)
    await mkdir(directory).catch(error => { if(error.code !== 'EEXIST') throw error })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The image attachment folder is redirected')
  }
  const ignorePath = await workspacePath(cwd,'.conductor/prompt-images/.gitignore',true)
  await writeFile(ignorePath,'*\n!.gitignore\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error})
  const id = randomUUID(), path = '.conductor/prompt-images/' + id + '.' + extension
  const target = await workspacePath(cwd,path,true)
  await writeFile(target,encoded,{flag:'wx'})
  return {id,kind:'image',name:name.replace(/[\\/\r\n\0]/g,'_').slice(0,160) || 'Pasted image',path}
}
