import { useEffect, useMemo, useState } from 'react'

export type PersonaProfile = {
  name: string
  profession: string
  profession_label: string
  industry: string
  specialty: string
  use_cases: string
  doc_style: string
  language: string
}

export const PERSONA_KEY = 'ada-persona'

export function loadPersona(): PersonaProfile | null {
  try {
    const raw = localStorage.getItem(PERSONA_KEY)
    return raw ? (JSON.parse(raw) as PersonaProfile) : null
  } catch { return null }
}

export function savePersona(profile: PersonaProfile) {
  localStorage.setItem(PERSONA_KEY, JSON.stringify(profile))
}

type TemplateLite = { id: string; name: string; profession: string; profession_label: string }

const STEP_TITLES = ['Welcome', 'Profession', 'Industry', 'Documentation', 'Output style', 'Language']

export default function Onboarding({ templates, onDone, onSkip }: {
  templates: TemplateLite[]
  onDone: (profile: PersonaProfile, profession: string) => void
  onSkip: () => void
}) {
  const [step, setStep] = useState(0)
  const [resumeHint, setResumeHint] = useState(false)
  const [name, setName] = useState('')
  const [professionChoice, setProfessionChoice] = useState('')
  const [customProfession, setCustomProfession] = useState('')
  const [industry, setIndustry] = useState('')
  const [useCases, setUseCases] = useState('')
  const [docStyle, setDocStyle] = useState('')
  const [language, setLanguage] = useState('English')

  const draft = useMemo<PersonaProfile>(() => ({
    name: name.trim() || 'there',
    profession: professionChoice === '__custom__' ? customProfession.trim().toLowerCase().replace(/\s+/g, '_') || 'custom' : professionChoice,
    profession_label: professionChoice === '__custom__'
      ? (customProfession.trim() || 'Custom role')
      : (templates.find(t => t.profession === professionChoice)?.profession_label || professionChoice),
    industry: industry.trim(),
    specialty: '',
    use_cases: useCases.trim(),
    doc_style: docStyle,
    language,
  }), [name, professionChoice, customProfession, industry, useCases, docStyle, language, templates])

  useEffect(() => {
    const saved = localStorage.getItem(PERSONA_KEY + '-draft')
    if (saved) { try { const d = JSON.parse(saved); if (d && d.step) { setResumeHint(true) } } catch {} }
  }, [])
  useEffect(() => {
    const savedDraft = localStorage.getItem(PERSONA_KEY + '-draft')
    const existing = loadPersona()
    const src = (savedDraft ? (() => { try { return JSON.parse(savedDraft) } catch { return null } })() : null) || existing
    if (!src) return
    if (src.name && src.name !== 'there') setName(src.name)
    if (src.professionChoice) { setProfessionChoice(src.professionChoice); setCustomProfession(src.customProfession || '') }
    else if (existing && src === existing && existing.profession) { setProfessionChoice(existing.profession) }
    if (src.industry) setIndustry(src.industry)
    if (src.use_cases) setUseCases(src.use_cases)
    if (src.doc_style) setDocStyle(src.doc_style)
    if (src.language) setLanguage(src.language)
  }, [])
  useEffect(() => {
    localStorage.setItem(PERSONA_KEY + '-draft', JSON.stringify({ step, name, professionChoice, customProfession, industry, useCases, docStyle, language }))
  }, [step, name, professionChoice, customProfession, industry, useCases, docStyle, language])

  const professionOptions = useMemo(() => {
    const seen = new Set<string>()
    const fromTemplates = templates.filter(t => t.profession !== 'generic')
    const out: TemplateLite[] = []
    for (const t of fromTemplates) {
      if (!seen.has(t.profession)) { seen.add(t.profession); out.push({ id: t.id, name: t.name, profession: t.profession, profession_label: t.profession_label }) }
    }
    out.push({ id: '__custom__', name: 'Create my own', profession: '__custom__', profession_label: 'My own role' })
    return out
  }, [templates])

  const templatePreview = templates.find(t => t.profession === draft.profession)
  const previewSections = templatePreview?.name
    ? `Template ready: ${templatePreview.name}`
    : `Ada will structure your work as a ${draft.profession_label || 'professional'}: a Summary and Key Points, keeping decisions and next steps clearly outlined. You can refine this from the document-type picker.`

  const canNext = step === 1
    ? (professionChoice === '__custom__' ? customProfession.trim().length > 1 : professionChoice.length > 0)
    : true

  function finish() {
    savePersona(draft)
    localStorage.removeItem(PERSONA_KEY + '-draft')
    localStorage.setItem('ada-profession', draft.profession)
    onDone(draft, draft.profession)
  }

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="Set up Ada">
      <div className="onboarding-card">
        <div className="onboarding-steps">
          {STEP_TITLES.map((t, i) => (
            <button key={t} onClick={() => setStep(i)} className={i === step ? 'ob-step current' : 'ob-step'}>{t}</button>
          ))}
        </div>
        <div className="onboarding-body">
          {step === 0 && (
            <>
              <h2>Let&apos;s set Ada up for your work</h2>
              <p>Tell Ada your name and what you do. She tailors every note to your role — nothing else changes.</p>
              <label>Your name or how you like to be addressed
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Dr. Adeyemi / Folake / …" />
              </label>
              {resumeHint && (
                <p className="ob-resume">We found a saved setup from last time — you can jump back with a step above or start over.</p>
              )}
            </>
          )}
          {step === 1 && (
            <>
              <h2>What are you?</h2>
              <div className="ob-grid">
                {professionOptions.map(o => (
                  <button key={o.id}
                    className={professionChoice === o.profession ? 'ob-option selected' : 'ob-option'}
                    onClick={() => setProfessionChoice(o.profession)}>
                    <strong>{o.profession_label}</strong><span>{o.name}</span>
                  </button>
                ))}
              </div>
              {professionChoice === '__custom__' && (
                <label>Describe your role
                  <input autoFocus value={customProfession} onChange={e => setCustomProfession(e.target.value)} placeholder="e.g. District water engineer" />
                </label>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <h2>Where do you work?</h2>
              <label>Industry or field
                <input autoFocus value={industry} onChange={e => setIndustry(e.target.value)} placeholder="Healthcare, Legal, Education, Construction, …" />
              </label>
              <label className="ob-optional">Anything about your specialty (optional)
                <input value={useCases} onChange={e => setUseCases(e.target.value)} placeholder="Cardiology, M&A, Yoruba-medium primary school…" />
              </label>
            </>
          )}
          {step === 3 && (
            <>
              <h2>What should Ada help you document?</h2>
              <label>Your typical notes
                <textarea autoFocus rows={3} value={industry.trim() === '' && !useCases ? '' : useCases} onChange={e => setUseCases(e.target.value)} placeholder="Patient encounters, site visits, meetings…" />
              </label>
              <p className="ob-hint">Ada keeps your raw notes safe and turns them into structured documents on the right.</p>
            </>
          )}
          {step === 4 && (
            <>
              <h2>How should documents look?</h2>
              <div className="ob-grid">
                {['Detailed and complete', 'Concise bullet style', 'Formal letter format', 'Keep it as I say it'].map(s => (
                  <button key={s} className={docStyle === s ? 'ob-option selected' : 'ob-option'} onClick={() => setDocStyle(s)}>{s}</button>
                ))}
              </div>
              <p className="ob-preview">{previewSections}</p>
            </>
          )}
          {step === 5 && (
            <>
              <h2>Last thing — language</h2>
              <label>Preferred language
                <select value={language} onChange={e => setLanguage(e.target.value)}>
                  {['English', 'Yorùbá', 'Hausa', 'Igbo', 'Français', 'Pidgin'].map(l => <option key={l}>{l}</option>)}
                </select>
              </label>
              <p className="ob-hint">You can change everything later from the workspace.</p>
            </>
          )}
        </div>
        <div className="onboarding-footer">
          <button className="ob-secondary" onClick={onSkip}>Skip for now</button>
          <div className="ob-actions">
            {step > 0 && <button className="ob-secondary" onClick={() => setStep(s => s - 1)}>Back</button>}
            {step < 5
              ? <button className="ob-primary" disabled={!canNext} onClick={() => setStep(s => s + 1)}>Next</button>
              : <button className="ob-primary" onClick={finish}>Start using Ada</button>}
          </div>
        </div>
      </div>
    </div>
  )
}