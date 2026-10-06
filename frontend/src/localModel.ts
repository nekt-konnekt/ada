import { pipeline } from '@huggingface/transformers'

type Profession = 'doctor' | 'lawyer'
type Section = { id: string; label: string; content: string }
type NeedInput = { id: string; question: string; section_id: string }
type Warning = { section_id: string | null; message: string; token: string }
export type LocalModelDocument = {
  title: string
  sections: Section[]
  needs_input: NeedInput[]
  warnings: Warning[]
  unplaced: string[]
  provider: string
  provider_name: string
}

const MODEL = 'onnx-community/Qwen3-0.6B-ONNX'
let generatorPromise: Promise<any> | null = null

const doctorSections = [
  ['chief_complaint','Chief Complaint'],
  ['history','History of Present Illness'],
  ['history_social_family','Past / Social / Family History'],
  ['allergies','Allergies'],
  ['observations','Observations / Vitals'],
  ['examination','Examination Findings'],
  ['investigations','Investigations'],
  ['assessment','Assessment'],
  ['plan','Plan'],
  ['follow_up','Follow-up'],
] as const

const lawyerSections = [
  ['parties','Parties'],
  ['facts','Facts / Incident Summary'],
  ['injuries','Injuries / Damages'],
  ['liability','Liability / Issues'],
  ['authorities','Authorities'],
  ['evidence','Supporting Information'],
  ['next_steps','Next Steps'],
] as const

function blank(profession: Profession): LocalModelDocument {
  const sections = profession === 'doctor' ? doctorSections : lawyerSections
  return { title: profession === 'doctor' ? 'Clinical Note' : 'Case Note', sections: sections.map(([id,label]) => ({id,label,content:''})), needs_input:[], warnings:[], unplaced:[], provider:'local-model', provider_name:'Qwen3 · on-device' }
}

function extractJson(text: string): any | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fenced = cleaned.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i)
  const candidate = fenced?.[1] || cleaned
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) } catch { return null }
}

function promptFor(profession: Profession, notes: string): string {
  const schema = profession === 'doctor' ? doctorSections : lawyerSections
  const sectionText = schema.map(([id,label]) => `{"id":"${id}","label":"${label}","content":""}`).join(',')
  return `You are Ada, a documentation structuring engine. Transform the user's raw notes into a professional draft. NEVER invent facts, diagnoses, measurements, dates, medications, names, or events. Preserve uncertain or missing information. Put each source fact in the best matching section. If a fact cannot be placed, put it in unplaced. Ask a concise question in needs_input only when a missing detail is necessary to complete a section. Return ONLY valid JSON. No markdown. Schema: {"title":"${profession === 'doctor' ? 'Clinical Note' : 'Case Note'}","sections":[${sectionText}],"needs_input":[],"warnings":[],"unplaced":[]}. User notes:\n${notes}`
}

async function getGenerator(onStatus?: (message: string) => void): Promise<any> {
  if (!generatorPromise) {
    generatorPromise = (async () => {
      onStatus?.('Loading local AI…')
      const useWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
      try {
        return await pipeline('text-generation', MODEL, { device: useWebGpu ? 'webgpu' : 'wasm', dtype: useWebGpu ? 'q4f16' : 'q4' })
      } catch (firstError) {
        if (useWebGpu) return await pipeline('text-generation', MODEL, { device: 'wasm', dtype: 'q4' })
        throw firstError
      }
    })()
  }
  return generatorPromise
}

export async function localModelStructure(profession: Profession, notes: string, onStatus?: (message: string) => void): Promise<LocalModelDocument> {
  const generator = await getGenerator(onStatus)
  onStatus?.('Ada · local AI')
  const messages = [
    { role:'system', content:'You are a strict JSON documentation engine. Output JSON only. Never invent facts.' },
    { role:'user', content: promptFor(profession, notes) },
  ]
  const output = await generator(messages, { max_new_tokens: 900, do_sample: false })
  const generated = output?.[0]?.generated_text
  const text = Array.isArray(generated) ? generated[generated.length - 1]?.content || '' : String(generated || '')
  const parsed = extractJson(text)
  if (!parsed) throw new Error('Local model returned an unreadable draft')
  const fallback = blank(profession)
  const allowed = new Set(fallback.sections.map(s => s.id))
  const sections = fallback.sections.map(section => {
    const found = Array.isArray(parsed.sections) ? parsed.sections.find((item:any) => String(item?.id) === section.id) : null
    return { ...section, content: found ? String(found.content || '').trim() : '' }
  })
  return {
    ...fallback,
    title: String(parsed.title || fallback.title),
    sections,
    needs_input: Array.isArray(parsed.needs_input) ? parsed.needs_input.map((x:any,i:number)=>({id:String(x?.id||'need_'+i),question:String(x?.question||''),section_id:allowed.has(String(x?.section_id))?String(x.section_id):''})).filter((x:NeedInput)=>x.question) : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map((x:any)=>({section_id:allowed.has(String(x?.section_id))?String(x.section_id):null,message:String(x?.message||''),token:String(x?.token||'')})).filter((x:Warning)=>x.message) : [],
    unplaced: Array.isArray(parsed.unplaced) ? parsed.unplaced.map(String).filter(Boolean) : [],
  }
}
