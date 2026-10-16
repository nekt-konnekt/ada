export type TemplateSection = { id: string; label: string }
export type TemplateShape = { id: string; name: string; sections: TemplateSection[] }
export type StructuredSection = TemplateSection & { content: string }
export type DraftShape = {
  template_id?: string
  title: string
  sections: StructuredSection[]
  needs_input: unknown[]
  warnings: unknown[]
  unplaced: string[]
  provider: string
  provider_name: string
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const SECTION_HINTS: Record<string, string[]> = {
  attendees: ['attend', 'present', 'joined', 'met with'],
  decisions: ['decid', 'agreed', 'approved', 'chose'],
  owners: ['owner', 'owns', 'responsible', 'assign'],
  deadlines: ['deadline', 'due', 'by ', 'friday', 'monday'],
  next_steps: ['next', 'follow up', 'action', 'send'],
  actions: ['action', 'next', 'todo', 'follow up'],
  open_questions: ['question', 'unclear', 'confirm', '?'],
}

export function buildTemplateDraft(template: TemplateShape, notes: string): DraftShape {
  const sentences = notes.split(/(?<=[.!?])\s+|\n+/).map(value => value.trim()).filter(Boolean)
  const used = new Set<string>()
  const sections = template.sections.map(section => {
    const hints = SECTION_HINTS[section.id] || [section.id.replace(/_/g, ' '), section.label.toLowerCase()]
    const matches = sentences.filter(sentence => hints.some(hint => sentence.toLowerCase().includes(hint)))
    matches.forEach(sentence => used.add(sentence))
    return { ...section, content: matches.join(' ') }
  })
  return {
    template_id: template.id,
    title: template.name,
    sections,
    needs_input: [],
    warnings: [],
    unplaced: sentences.filter(sentence => !used.has(sentence)),
    provider: 'local-device',
    provider_name: 'on-device mode',
  }
}

export function mergeLockedSections<T extends DraftShape>(current: DraftShape, generated: T, locked: Set<string>): T {
  const currentById = new Map(current.sections.map(section => [section.id, section]))
  const sections = generated.sections.map(section => {
    const saved = currentById.get(section.id)
    return locked.has(section.id) && saved ? saved : section
  })
  const present = new Set(sections.map(section => section.id))
  for (const section of current.sections) {
    if (locked.has(section.id) && !present.has(section.id)) sections.push(section)
  }
  return { ...generated, sections }
}

export function accountCanGenerate(account: any): boolean {
  if (!account?.authenticated) return false
  if (account.plan === 'pro' || account.usage?.limit == null) return true
  const used = Number(account.usage?.used ?? 0)
  const limit = Number(account.usage?.limit ?? 0)
  return used < limit
}

export function isLatestSessionResponse(responseOrder: number, latestOrder: number): boolean {
  return responseOrder === latestOrder
}

export function validProfessionChoice(choice: string, customProfession: string): boolean {
  return choice === '__custom__' ? customProfession.trim().length > 1 : choice.length > 0
}

export function documentTitleForProfession(profession: string): string {
  return profession === 'doctor' ? 'Clinical Note' : profession === 'lawyer' ? 'Case Note' : 'Professional Document'
}

export function safeStorageGet(storage: StorageLike, key: string): string | null {
  try { return storage.getItem(key) } catch { return null }
}

export function safeStorageSet(storage: StorageLike, key: string, value: string): boolean {
  try { storage.setItem(key, value); return true } catch { return false }
}

export function safeStorageRemove(storage: StorageLike, key: string): boolean {
  try { storage.removeItem(key); return true } catch { return false }
}
