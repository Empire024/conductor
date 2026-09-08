import { useEffect, useRef, useState } from 'react'
import { ImagePlus, LoaderCircle } from 'lucide-react'
import type { ContextAttachment } from '../../../shared/structured-agent'

export function PromptImageUpload({ projectId, disabled, onAttach, onError }: {projectId:string; disabled:boolean; onAttach(images:ContextAttachment[]):void; onError(message:string):void}): React.JSX.Element {
  const host=useRef<HTMLSpanElement>(null), input=useRef<HTMLInputElement>(null)
  const [busy,setBusy]=useState(false)
  const pending=useRef(false)
  const upload=async (files:File[]):Promise<void> => {
    if(disabled || pending.current || !files.length) return
    const added:ContextAttachment[]=[]
    pending.current=true; setBusy(true)
    try {
      if(files.length>20) throw new Error('Attach up to 20 images at a time')
      for(const file of files) {
        if(file.size>20*1024*1024) throw new Error(file.name+' is larger than 20 MB')
        added.push(await window.conductor.files.importImage(projectId,file.name || 'Pasted image',new Uint8Array(await file.arrayBuffer())))
      }
    } catch(error) {onError(error instanceof Error ? error.message : String(error))}
    finally { if(added.length) onAttach(added); pending.current=false;setBusy(false) }
  }
  useEffect(()=> {
    const form=host.current?.closest('form')
    if(!form) return
    const paste=(event:ClipboardEvent):void=> {
      const files=Array.from(event.clipboardData?.files ?? []).filter(file=>file.type.startsWith('image/'))
      if(!files.length || disabled) return
      event.preventDefault(); void upload(files)
    }
    const drop=(event:DragEvent):void=> {
      const files=Array.from(event.dataTransfer?.files ?? [])
      if(!files.length) return
      event.preventDefault(); event.stopPropagation()
      if(disabled) return
      void upload(files)
    }
    const over=(event:DragEvent):void=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault()}
    form.addEventListener('paste',paste);form.addEventListener('drop',drop);form.addEventListener('dragover',over)
    return()=>{form.removeEventListener('paste',paste);form.removeEventListener('drop',drop);form.removeEventListener('dragover',over)}
  },[projectId,disabled,onAttach,onError])
  return <span ref={host} className="sa-image-upload"><input ref={input} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" multiple aria-label="Choose prompt images" onChange={event=>{void upload(Array.from(event.target.files??[]));event.target.value=''}} />
    <button type="button" aria-label="Upload images" title="Upload images, paste a screenshot, or drop images here" disabled={disabled || busy} onClick={()=>input.current?.click()}>{busy ? <LoaderCircle size={14} className="spin"/> : <ImagePlus size={14}/>}</button>
  </span>
}

export function PromptImageThumbnail({ projectId, attachment }: {projectId:string;attachment:ContextAttachment}):React.JSX.Element|null {
  const [url,setUrl]=useState('')
  useEffect(()=>{let live=true; if(attachment.path)void window.conductor.files.readDataUrl(projectId,attachment.path).then(value=>{if(live)setUrl(value.dataUrl)}).catch(()=>{});return()=>{live=false}},[projectId,attachment.path])
  return url ? <img className="sa-image-thumbnail" src={url} alt={attachment.name}/> : null
}
