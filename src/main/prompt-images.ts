import { nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { workspacePath } from './agent-artifacts'
import type { ContextAttachment } from '../shared/structured-agent'

/** Uploaded bytes become immutable workspace images, so providers and restored drafts share them. */
export async function importPromptImage(cwd: string, name: unknown, input: unknown): Promise<ContextAttachment> {
  if (typeof name !== 'string' || !(input instanceof Uint8Array) || !input.byteLength || input.byteLength > 20 * 1024 * 1024) throw new Error('Choose an image no larger than 20 MB')
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
  let extension = 'png'
  if (encoded.length > 2 * 1024 * 1024) { encoded = image.toJPEG(90); extension = 'jpg' }
  while (encoded.length > 2 * 1024 * 1024) {
    ;({width,height} = image.getSize())
    if (Math.max(width,height) < 512) throw new Error('Image could not be prepared within the attachment limit')
    image = image.resize({width:Math.round(width*.75)})
    encoded = image.toJPEG(85)
  }
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
