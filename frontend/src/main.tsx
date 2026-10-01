import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import { jsPDF } from 'jspdf'
import './styles.css'

type Profession = 'doctor' | 'lawyer'
type Section = { id: string; label: string; content: string }
type NeedInput = { id: string; question: string; section_id: string }
type Warning = { section_id: string | null; message: string; token: string }
type WorkspaceMode = 'quick' | 'professional'
type DocumentState = { title: string; sections: Section[]; needs_input: NeedInput[]; warnings: Warning[]; unplaced: string[]; provider: string; provider_name: string }
type SavedNote = { id: string; profession: Profession; document: DocumentState; createdAt: string; updatedAt: string }

const DB_NAME = 'ada-local';
const DB_VERSION = 2;
const STORE_NAME = 'notes';
const ADA_SUPABASE_URL = 'https://husahdwqvoboguaceerd.supabase.co';
const ADA_SUPABASE_KEY = 'sb_publishable_hxSlGSUqfrpQzunQ66m3EQ_PecORFor';
const PROFESSION_KEY = 'ada-profession';
const TERMS_VERSION = '1.0';
const PRIVACY_VERSION = '1.0';
const ONBOARDED_KEY = 'ada-onboarded';

function openNotesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      } else if (oldVersion < 2) {
        const tx = request.transaction;
        if (tx) {
          const store = tx.objectStore(STORE_NAME);
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const value = cursor.value as Record<string, unknown>;
            if ('notes' in value) {
              delete value.notes;
              cursor.update(value);
            }
            cursor.continue();
          };
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveLocalNote(note: SavedNote): Promise<void> {
  const db = await openNotesDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(note);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function listLocalNotes(): Promise<SavedNote[]> {
  const db = await openNotesDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => { db.close(); resolve((request.result as SavedNote[]).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}


async function deleteLocalNote(id: string): Promise<void> {
  const db = await openNotesDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
async function joinWaitlist(name: string, email: string, phone: string, profession: Profession, agreement: { termsVersion: string; termsAcceptedAt: string; privacyVersion: string; privacyAcknowledgedAt: string; professionalAcknowledgedAt: string }): Promise<void> {
  const response = await fetch(ADA_SUPABASE_URL + '/rest/v1/waitlist', {
    method: 'POST', headers: { apikey: ADA_SUPABASE_KEY, Authorization: 'Bearer ' + ADA_SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), phone: phone.trim(), profession, terms_version: agreement.termsVersion, terms_accepted_at: agreement.termsAcceptedAt, privacy_version: agreement.privacyVersion, privacy_acknowledged_at: agreement.privacyAcknowledgedAt, professional_acknowledged_at: agreement.professionalAcknowledgedAt }),
  });
  if (!response.ok && response.status !== 409) throw new Error('Could not join the waitlist');
}

async function saveRawNoteToAda(profession: Profession, notes: string): Promise<void> {
  const response = await fetch(`${ADA_SUPABASE_URL}/rest/v1/raw_notes`, {
    method: 'POST',
    headers: {
      apikey: ADA_SUPABASE_KEY,
      Authorization: `Bearer ${ADA_SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ id: crypto.randomUUID(), profession, notes }),
  });
  if (!response.ok) throw new Error('Ada could not store the raw note');
}

let paddleOcrPromise: Promise<any> | null = null;

async function runPaddleOcr(file: File): Promise<string> {
  if (!paddleOcrPromise) {
    paddleOcrPromise = import('@paddleocr/paddleocr-js').then(async ({ PaddleOCR }) =>
      PaddleOCR.create({
        lang: 'en',
        ocrVersion: 'PP-OCRv5',
        ortOptions: { backend: 'auto' },
      })
    );
  }
  const ocr = await paddleOcrPromise;
  const [result] = await ocr.predict(file);
  return (result?.items ?? [])
    .map((item: { text?: string }) => item.text?.trim() || '')
    .filter(Boolean)
    .join('\n');
}



function safeFilePart(value: string): string {
  return value
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Professional_Document'
}

function exportBaseName(document: DocumentState): string {
  const date = new Date().toISOString().slice(0, 10)
  return `Ada_${safeFilePart(document.title)}_${date}`
}

function normalizeDocument(document: any): DocumentState {
  return {
    title: String(document?.title || 'Professional Document'),
    sections: Array.isArray(document?.sections) ? document.sections.map((section: any) => ({ id: String(section?.id || ''), label: String(section?.label || ''), content: String(section?.content || '') })) : [],
    needs_input: Array.isArray(document?.needs_input) ? document.needs_input.map((item: any) => typeof item === 'string' ? { id: 'needs_input', question: item, section_id: '' } : { id: String(item?.id || 'needs_input'), question: String(item?.question || item?.text || ''), section_id: String(item?.section_id || '') }).filter((item: NeedInput) => item.question.trim()) : [],
    warnings: Array.isArray(document?.warnings) ? document.warnings : [],
    unplaced: Array.isArray(document?.unplaced) ? document.unplaced.map(String) : [],
    provider: String(document?.provider || 'ready'),
    provider_name: String(document?.provider_name || 'local demo'),
  }
}

function documentExportText(document: DocumentState): Array<{ label: string; content: string }> {
  return document.sections.filter(section => section.content.trim()).map(section => ({ label: section.label, content: section.content.trim() }))
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function inlineRichText(value: string): string {
  return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>')
}

function formatClipboardContent(document: DocumentState): { html: string; text: string } {
  const parts: string[] = ['<div style="font-family:Arial,sans-serif;line-height:1.5">', '<p><strong>' + escapeHtml(document.title) + '</strong></p>']
  const textParts: string[] = [document.title]
  for (const section of documentExportText(document)) {
    parts.push('<p><strong>' + escapeHtml(section.label) + '</strong></p>')
    textParts.push('', section.label)
    const lines = section.content.split(/\r?\n/)
    let listType: 'ul' | 'ol' | null = null
    let listItems: string[] = []
    const flushList = () => {
      if (!listType || listItems.length === 0) return
      parts.push('<' + listType + '>' + listItems.map(item => '<li>' + inlineRichText(item) + '</li>').join('') + '</' + listType + '>')
      listType = null
      listItems = []
    }
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*•]\s+(.+)$/)
      const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/)
      if (bullet || numbered) {
        const nextType = bullet ? 'ul' : 'ol'
        if (listType && listType !== nextType) flushList()
        listType = nextType
        listItems.push((bullet || numbered)![1])
        continue
      }
      flushList()
      if (line.trim()) { parts.push('<p>' + inlineRichText(line) + '</p>'); textParts.push(line) } else textParts.push('')
    }
    flushList()
  }
  if (document.needs_input.length > 0) {
    parts.push('<p><strong>Needs your input</strong></p><ul>' + document.needs_input.map(item => '<li>' + inlineRichText(item.question) + '</li>').join('') + '</ul>')
    textParts.push('', 'Needs your input', ...document.needs_input.map(item => '• ' + item.question))
  }
  parts.push('</div>')
  return { html: parts.join(''), text: textParts.join('\n') }
}

async function copyDocumentToClipboard(document: DocumentState): Promise<void> {
  const formatted = formatClipboardContent(document)
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    const item = new ClipboardItem({ 'text/html': new Blob([formatted.html], { type: 'text/html' }), 'text/plain': new Blob([formatted.text], { type: 'text/plain' }) })
    await navigator.clipboard.write([item])
    return
  }
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(formatted.text); return }
  throw new Error('Clipboard access is unavailable')
}

async function exportDocx(document: DocumentState): Promise<void> {
  const children: Paragraph[] = [
    new Paragraph({
      text: document.title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 280 },
    }),
  ]

  for (const section of documentExportText(document)) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: section.label, bold: true })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 220, after: 100 },
      }),
      new Paragraph({
        children: [new TextRun(section.content)],
        spacing: { after: 160 },
      }),
    )
  }

  if (document.needs_input.length > 0) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: 'Needs your input', bold: true })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 220, after: 100 },
      }),
      new Paragraph({
        children: [new TextRun(document.needs_input.map(item => item.question).join(' · '))],
      }),
    )
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  })
  const blob = await Packer.toBlob(doc)
  const url = URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  link.href = url
  link.download = `${exportBaseName(document)}.docx`
  link.click()
  URL.revokeObjectURL(url)
}

function exportPdf(document: DocumentState): void {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' })
  const margin = 54
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const contentWidth = pageWidth - margin * 2
  let y = 64

  const ensureSpace = (height: number) => {
    if (y + height > pageHeight - margin) {
      pdf.addPage()
      y = margin
    }
  }

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(20)
  const titleLines = pdf.splitTextToSize(document.title, contentWidth)
  ensureSpace(titleLines.length * 24)
  pdf.text(titleLines, margin, y)
  y += titleLines.length * 24 + 18

  for (const section of documentExportText(document)) {
    const labelLines = pdf.splitTextToSize(section.label, contentWidth)
    const bodyLines = pdf.splitTextToSize(section.content, contentWidth)
    const bodyHeight = bodyLines.length * 16
    ensureSpace(labelLines.length * 16 + bodyHeight + 24)

    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(10)
    pdf.text(labelLines, margin, y)
    y += labelLines.length * 16 + 5

    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(11)
    pdf.text(bodyLines, margin, y)
    y += bodyHeight + 18
  }

  if (document.needs_input.length > 0) {
    const needs = pdf.splitTextToSize(document.needs_input.map(item => item.question).join(' · '), contentWidth)
    ensureSpace(needs.length * 16 + 28)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(10)
    pdf.text('Needs your input', margin, y)
    y += 15
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(10)
    pdf.text(needs, margin, y)
  }

  pdf.save(`${exportBaseName(document)}.pdf`)
}

type Store = {
  profession: Profession
  notes: string
  document: DocumentState
  focusedSection: string | null
  setProfession: (p: Profession) => void
  setNotes: (n: string) => void
  setDocument: (d: DocumentState) => void
  editSection: (id: string, content: string) => void
  unlockSection: (id: string) => void
  lockedSections: Set<string>
  setFocused: (id: string | null) => void
}

const emptyDoc = (profession: Profession): DocumentState => profession === 'doctor'
  ? { title: 'Clinical Note', sections: [
      { id:'chief_complaint', label:'Chief Complaint', content:'' }, { id:'history', label:'History of Present Illness', content:'' },
      { id:'history_social_family', label:'Past / Social / Family History', content:'' }, { id:'allergies', label:'Allergies', content:'' },
      { id:'observations', label:'Observations / Vitals', content:'' }, { id:'examination', label:'Examination Findings', content:'' },
      { id:'investigations', label:'Investigations', content:'' }, { id:'assessment', label:'Assessment', content:'' },
      { id:'plan', label:'Plan', content:'' }, { id:'follow_up', label:'Follow-up', content:'' }
    ], needs_input: [], warnings: [], unplaced: [], provider:'ready', provider_name:'local demo' }
  : { title: 'Case Note', sections: [
      { id:'parties', label:'Parties', content:'' }, { id:'facts', label:'Facts / Incident Summary', content:'' },
      { id:'injuries', label:'Injuries / Damages', content:'' }, { id:'liability', label:'Liability / Issues', content:'' },
      { id:'authorities', label:'Authorities', content:'' }, { id:'evidence', label:'Supporting Information', content:'' }, { id:'next_steps', label:'Next Steps', content:'' }
    ], needs_input: [], warnings: [], unplaced: [], provider:'ready', provider_name:'local demo' }

const useAda = create<Store>((set) => ({
  profession: 'doctor', notes: '', document: emptyDoc('doctor'), focusedSection: null, lockedSections: new Set<string>(),
  setProfession: (profession) => set({ profession, document: emptyDoc(profession), lockedSections: new Set<string>() }),
  setNotes: (notes) => set({ notes }), setDocument: (document) => set({ document: normalizeDocument(document) }),
  editSection: (id, content) => set(s => { const locked = new Set(s.lockedSections); locked.add(id); return { lockedSections: locked, document: { ...s.document, sections: s.document.sections.map(x => x.id === id ? {...x, content} : x) } } }),
  unlockSection: (id) => set(s => { const locked = new Set(s.lockedSections); locked.delete(id); return { lockedSections: locked } }),
  setFocused: (focusedSection) => set({ focusedSection })
}))

function goTo(path: string) { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')) }

function hasAdaPresence(): boolean {
  const profession = localStorage.getItem(PROFESSION_KEY);
  return profession === 'doctor' || profession === 'lawyer';
}

function PublicPage({ waitlist = false }: { waitlist?: boolean }) {
  useEffect(() => {
    if (waitlist && hasAdaPresence()) goTo('/0.1');
  }, [waitlist])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [profession, setProfession] = useState<Profession>('doctor')
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false)
  const [professionalAcknowledged, setProfessionalAcknowledged] = useState(false)
  const [state, setState] = useState('Join waitlist')
  async function submit() {
    if (!name.trim()) return setState('Enter name')
    if (!email.trim()) return setState('Enter email')
    if (!phone.trim()) return setState('Enter phone')
    if (!termsAccepted) return setState('Accept the user agreement')
    if (!privacyAcknowledged) return setState('Acknowledge the privacy notice')
    if (!professionalAcknowledged) return setState('Acknowledge professional responsibility')
    setState('Joining…')
    try {
      const acceptedAt = new Date().toISOString()
      await joinWaitlist(name, email, phone, profession, { termsVersion: TERMS_VERSION, termsAcceptedAt: acceptedAt, privacyVersion: PRIVACY_VERSION, privacyAcknowledgedAt: acceptedAt, professionalAcknowledgedAt: acceptedAt })
      if (new URLSearchParams(window.location.search).get('from') === 'try') {
        localStorage.setItem('ada-profession', profession)
        localStorage.setItem(ONBOARDED_KEY, 'true')
        goTo('/0.1')
        return
      }
      setState('You’re on the list')
      setName('')
      setEmail('')
      setPhone('')
      setTermsAccepted(false)
      setPrivacyAcknowledged(false)
      setProfessionalAcknowledged(false)
    }
    catch { setState('Could not join') }
    window.setTimeout(() => setState('Join waitlist'), 2200)
  }
  if (waitlist) return <main className="public-page"><header className="public-top"><button className="public-brand" onClick={()=>goTo('/')}><strong>ada</strong><span>write naturally. structure professionally.</span></button></header><section className="public-content"><span className="eyebrow">EARLY ACCESS</span><h1>Join the early-access list</h1><p>Ada is being built for doctors and lawyers who want to turn rough notes into structured professional documents without stopping to format everything themselves.</p><div className="public-form"><label>Full name<input className="waitlist-input" value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" autoComplete="name" /></label><label>Email<input className="waitlist-input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" /></label><label>Phone number<input className="waitlist-input" type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+234 801 234 5678" autoComplete="tel" /></label><div className="public-role"><span>Profession</span><div><button className={profession==='doctor'?'selected':''} onClick={()=>setProfession('doctor')}>Doctor</button><button className={profession==='lawyer'?'selected':''} onClick={()=>setProfession('lawyer')}>Lawyer</button></div></div><div className="agreement-box"><span className="agreement-title">Before you continue</span><label className="agreement-check"><input type="checkbox" checked={termsAccepted} onChange={e=>setTermsAccepted(e.target.checked)} /><span>I agree to the Ada user agreement (v1.0), including the rules for using Ada as a documentation aid.</span></label><label className="agreement-check"><input type="checkbox" checked={privacyAcknowledged} onChange={e=>setPrivacyAcknowledged(e.target.checked)} /><span>I acknowledge the Privacy Notice (v1.0) and understand that information I submit may be processed to provide Ada.</span></label><label className="agreement-check"><input type="checkbox" checked={professionalAcknowledged} onChange={e=>setProfessionalAcknowledged(e.target.checked)} /><span>I understand that I remain responsible for reviewing, correcting, and approving professional documents before relying on them.</span></label><small className="agreement-note">Ada structures information you provide. It does not replace professional judgment.</small></div><button className="waitlist-submit" onClick={submit}>{state}</button></div><div className="public-next"><strong>What happens next</strong><p>We'll contact you when Ada is ready for your professional workspace.</p></div><small className="privacy-note">No spam. Early access updates only.</small></section><footer><span>ada.            2026.            made with ❤️ in 🇳🇬.</span></footer></main>
  return <main className="public-page"><header className="public-top"><div className="public-brand"><strong>ada</strong><span>write naturally. structure professionally.</span></div></header><section className="public-content"><span className="eyebrow">ADA EARLY ACCESS</span><h1>Write like you think. Document like a pro.</h1><p>Ada lets you scribble freely while you work, then structures what is actually there into a professional document when you need it.</p><section className="public-problems"><span className="eyebrow">THE PROBLEM</span><h2>Your notes don't arrive in professional structure.</h2><div className="public-problem-grid"><article><span className="eyebrow">FOR DOCTORS</span><h3>A patient talks. You observe. You remember.</h3><p>Symptoms, observations, medications and follow-up details come in as the consultation happens. The work of putting them into a proper clinical note comes afterwards.</p></article><article><span className="eyebrow">FOR LAWYERS</span><h3>A client tells you what happened. You collect the pieces.</h3><p>Names, dates, events, allegations, documents and things to verify rarely arrive in the order your case note needs. Structuring them is a separate job.</p></article></div><p className="public-problem-close">Other tools force you into rigid forms while you're talking to patients or clients. Ada lets you scribble freely, then structures it after. Paper notes, digital chaos, one workflow.</p></section><div className="public-actions"><article><span className="eyebrow">ADA 0.1</span><h2>{hasAdaPresence() ? 'Continue with Ada' : 'Try Ada 0.1'}</h2><p>{hasAdaPresence() ? 'Your Ada workspace is ready. Continue where you left off.' : 'The first working version of Ada is available to try now.'}</p><button onClick={()=>goTo(hasAdaPresence() ? '/0.1' : '/waitlist?from=try')}>{hasAdaPresence() ? 'Open Ada' : 'Try Ada'}</button></article><article><span className="eyebrow">EARLY ACCESS</span><h2>Join the early-access list</h2><p>Get notified as Ada opens up to more professionals.</p><button onClick={()=>goTo('/waitlist')}>Join waitlist</button></article></div></section><footer><span>ada.            2026.            made with ❤️ in 🇳🇬.</span></footer></main>
}

function App() {
  const { profession, notes, document, focusedSection, lockedSections } = useAda()
  const setNotes = useAda(s=>s.setNotes), setProfession=useAda(s=>s.setProfession), setDocument=useAda(s=>s.setDocument)
  const setFocused=useAda(s=>s.setFocused), editSection=useAda(s=>s.editSection), unlockSection=useAda(s=>s.unlockSection)
  const [status, setStatus] = useState('Ready')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('professional')
  const [professionLocked, setProfessionLocked] = useState<Profession | null>(null)
  const [split, setSplit] = useState(50)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<SavedNote[]>([])
  const [saveState, setSaveState] = useState('Save Note')
  const [scanState, setScanState] = useState('Scan note')
  const [actionsOpen, setActionsOpen] = useState(false)
  const [exportState, setExportState] = useState<'idle' | 'docx' | 'pdf'>('idle')
  const [copyState, setCopyState] = useState('Copy to Clipboard')
  const fileInput = useRef<HTMLInputElement | null>(null)
  const scribbleCanvas = useRef<HTMLCanvasElement | null>(null)
  const scribbleStrokes = useRef<Array<Array<{x:number;y:number}>>>([])
  const scribbleCurrent = useRef<Array<{x:number;y:number}> | null>(null)
  const [scribbleMode, setScribbleMode] = useState(false)
  const [scribbleState, setScribbleState] = useState('Convert to notes')
  const timer = useRef<number | undefined>(undefined)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    listLocalNotes().then(setHistory).catch(() => setStatus('Local history unavailable'))
    const savedProfession = localStorage.getItem(PROFESSION_KEY) as Profession | null
    if (savedProfession === 'doctor' || savedProfession === 'lawyer') { setProfessionLocked(savedProfession); setProfession(savedProfession) }
    try {
      const draft = localStorage.getItem('ada-current-draft')
      if (draft) {
        const parsed = JSON.parse(draft) as { profession: Profession; document: DocumentState }
        if (parsed.document) {
          useAda.setState({ profession: parsed.profession, notes: '', document: normalizeDocument(parsed.document), lockedSections: new Set<string>() })
          localStorage.setItem('ada-current-draft', JSON.stringify({ profession: parsed.profession, document: normalizeDocument(parsed.document) }))
          setStatus('Structured document restored from this device')
        }
      }
    } catch {}
  }, [])

  useEffect(() => {
    try { localStorage.setItem('ada-current-draft', JSON.stringify({ profession, document })) } catch {}
  }, [profession, notes, document])

  function resizeScribbleCanvas() {
    const canvas = scribbleCanvas.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(rect.width * ratio))
    canvas.height = Math.max(1, Math.floor(rect.height * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 2.2
    ctx.strokeStyle = '#25302d'
    redrawScribble()
  }

  function redrawScribble() {
    const canvas = scribbleCanvas.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 2.2
    ctx.strokeStyle = '#25302d'
    for (const stroke of scribbleStrokes.current) {
      if (stroke.length < 2) continue
      ctx.beginPath()
      ctx.moveTo(stroke[0].x, stroke[0].y)
      for (const point of stroke.slice(1)) ctx.lineTo(point.x, point.y)
      ctx.stroke()
    }
  }

  function scribblePoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function startScribble(event: React.PointerEvent<HTMLCanvasElement>) {
    scribbleCurrent.current = [scribblePoint(event)]
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveScribble(event: React.PointerEvent<HTMLCanvasElement>) {
    const stroke = scribbleCurrent.current
    if (!stroke) return
    const point = scribblePoint(event)
    const previous = stroke[stroke.length - 1]
    stroke.push(point)
    const ctx = event.currentTarget.getContext('2d')
    if (!ctx || !previous) return
    ctx.beginPath()
    ctx.moveTo(previous.x, previous.y)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }

  function endScribble() {
    const stroke = scribbleCurrent.current
    if (stroke && stroke.length > 0) scribbleStrokes.current.push(stroke)
    scribbleCurrent.current = null
  }

  function clearScribble() {
    scribbleStrokes.current = []
    scribbleCurrent.current = null
    redrawScribble()
  }

  function undoScribble() {
    scribbleStrokes.current.pop()
    redrawScribble()
  }

  async function convertScribbleToNotes() {
    const canvas = scribbleCanvas.current
    if (!canvas || scribbleStrokes.current.length === 0) {
      setScribbleState('Write something first')
      window.setTimeout(() => setScribbleState('Convert to notes'), 1600)
      return
    }
    setScribbleState('Reading…')
    setStatus('Reading handwriting locally…')
    try {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Could not capture handwriting')
      const extracted = await runPaddleOcr(new File([blob], 'ada-scribble.png', { type: 'image/png' }))
      if (!extracted.trim()) throw new Error('No readable handwriting found')
      setNotes(notes.trim() ? notes.trim() + '\n\n' + extracted : extracted)
      setScribbleState('Added to notes')
      setStatus('Handwriting converted. Review it before Ada structures it.')
      setScribbleMode(false)
      clearScribble()
    } catch (e) {
      setScribbleState('Try again')
      setStatus('Handwriting conversion failed: ' + (e as Error).message)
    } finally {
      window.setTimeout(() => setScribbleState('Convert to notes'), 1800)
    }
  }

  async function handleScan(file: File) {
    if (!file.type.startsWith('image/')) {
      setScanState('Image only')
      window.setTimeout(() => setScanState('Scan note'), 1600)
      return
    }
    setScanState('Reading…')
    setStatus('Reading scanned note locally…')
    try {
      const extracted = await runPaddleOcr(file)
      if (!extracted.trim()) throw new Error('No readable text found')
      const combined = notes.trim() ? notes.trim() + '\n\n' + extracted : extracted
      setNotes(combined)
      setScanState('Scanned')
      setStatus('Scanned text loaded. Review it before Ada structures it.')
      window.setTimeout(() => setScanState('Scan note'), 1800)
    } catch (e) {
      setScanState('Try again')
      setStatus('Scan failed: ' + (e as Error).message)
      window.setTimeout(() => setScanState('Scan note'), 1800)
    } finally {
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function handleSave() {
    if (!notes.trim()) { setSaveState('Write a note first'); return }
    setSaveState('Saving…')
    const now = new Date().toISOString()
    const saved: SavedNote = {
      id: crypto.randomUUID(), profession, document,
      createdAt: now, updatedAt: now
    }
    try {
      await saveRawNoteToAda(profession, notes)
      await saveLocalNote(saved)
      const next = await listLocalNotes()
      setHistory(next)
      setSaveState('Saved to Ada + device')
      window.setTimeout(() => setSaveState('Save Note'), 1800)
    } catch {
      setSaveState('Could not save locally')
    }
  }

  function chooseProfession(next: Profession) {
    localStorage.setItem(PROFESSION_KEY, next)
    setProfessionLocked(next)
    setProfession(next)
  }

  function openSaved(note: SavedNote) {
    useAda.setState({ profession: note.profession, notes: '', document: normalizeDocument(note.document), focusedSection: null, lockedSections: new Set<string>() })
    setHistoryOpen(false)
    setStatus('Opened from this device')
  }

  async function removeSaved(id: string) {
    await deleteLocalNote(id)
    setHistory(await listLocalNotes())
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.document.querySelectorAll<HTMLTextAreaElement>('.doc-section textarea').forEach(area => {
        area.style.height = 'auto'
        area.style.height = area.scrollHeight + 'px'
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [document.sections])

  useEffect(() => {
    if (!scribbleMode) return
    const frame = window.requestAnimationFrame(resizeScribbleCanvas)
    window.addEventListener('resize', resizeScribbleCanvas)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', resizeScribbleCanvas)
    }
  }, [scribbleMode])

  useEffect(() => {
    window.clearTimeout(timer.current)
    if (!notes.trim() || workspaceMode === 'quick') {
      if (!notes.trim() && workspaceMode === 'professional') { setDocument(emptyDoc(profession)); useAda.setState({ lockedSections: new Set<string>() }) }
      if (!notes.trim()) setStatus('Ready')
      return
    }
    timer.current = window.setTimeout(async () => {
      request.current?.abort(); request.current = new AbortController(); setStatus('Updating…')
      try {
        const r = await fetch('/api/structure', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({profession, notes, current_document:document}), signal:request.current.signal })
        if (!r.ok) {
          let detail = 'Request failed'
          try {
            const errorBody = await r.json()
            if (typeof errorBody?.detail === 'string') detail = errorBody.detail
          } catch {}
          throw new Error(detail)
        }
        const next = normalizeDocument(await r.json())
        const current = useAda.getState()
        const merged = { ...next, sections: next.sections.map(section => { const currentSection = current.document.sections.find(item => item.id === section.id); return current.lockedSections.has(section.id) && currentSection ? currentSection : section }) }
        setDocument(merged); setStatus(next.provider === 'local-demo' ? 'Local demo engine' : 'Live: ' + next.provider)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setStatus('Could not update: ' + (e as Error).message)
      }
    }, 650)
    return () => window.clearTimeout(timer.current)
  }, [notes, profession, workspaceMode])

  function handlePointer(e: React.PointerEvent<HTMLDivElement>) {
    const parent = e.currentTarget.parentElement?.getBoundingClientRect(); if (!parent) return
    const pct = Math.max(30, Math.min(70, ((e.clientX-parent.left)/parent.width)*100)); setSplit(pct)
  }

  return <main className="app">
    <header className="topbar">
      <div className="brand"><div><strong>ada</strong><span>write naturally. structure professionally.</span></div></div>
      <div className="mode-switch" aria-label="Workspace mode">
        <button className={workspaceMode==='quick' ? 'active' : ''} onClick={()=>{setWorkspaceMode('quick');setStatus(notes.trim()?'Quick note':'Ready')}}>Quick Note</button>
        <button className={workspaceMode==='professional' ? 'active' : ''} onClick={()=>{setWorkspaceMode('professional');setStatus(notes.trim()?'Updating…':'Ready')}}>Professional Document</button>
      </div>
      <span className="locked-mode">{professionLocked === null ? 'Clinical mode (preview)' : (profession==='doctor' ? 'Doctor' : 'Lawyer') + ' · locked'}</span>
      <button className="waitlist-button" onClick={()=>goTo("/waitlist")}>Waitlist</button>
      <div className="status"><i></i>{status}</div>
    </header>
    <section className="workspace" style={{gridTemplateColumns:`${split}% 8px ${100-split}%`}}>
      <section className="pane notes-pane">
        <div className="pane-head"><div><span className="eyebrow">01 · YOUR NOTES</span><h2 className="notes-heading">Write however you think.</h2></div><div className="head-actions"><span className="hint">{notes.length.toLocaleString()} chars</span><button className="history-button" onClick={()=>setHistoryOpen(true)}>History{history.length ? <b>{history.length}</b> : null}</button></div></div>
        <div className="notes-input-mode"><button type="button" className={!scribbleMode ? 'active' : ''} onClick={()=>setScribbleMode(false)}>Type</button><button type="button" className={scribbleMode ? 'active' : ''} onClick={()=>{setScribbleMode(true); window.requestAnimationFrame(resizeScribbleCanvas)}}>Scribble</button></div>
        {scribbleMode ? <div className="scribble-wrap">
          <div className="scribble-toolbar"><span>Use Apple Pencil, stylus, or finger.</span><div><button type="button" onClick={undoScribble}>Undo</button><button type="button" onClick={clearScribble}>Clear</button><button type="button" className="scribble-convert" onClick={()=>{void convertScribbleToNotes()}}>{scribbleState}</button></div></div>
          <canvas ref={scribbleCanvas} className="scribble-canvas" onPointerDown={startScribble} onPointerMove={moveScribble} onPointerUp={endScribble} onPointerCancel={endScribble} aria-label="Handwriting input area" />
          <small className="scribble-note">Handwriting is converted into your notes. Ada structures the converted text, not the drawing itself.</small>
        </div> : <textarea autoFocus value={notes} onChange={e=>setNotes(e.target.value)} placeholder={profession==='doctor' ? 'Start scribbling…\n\npatient came in complaining of chest pain since yesterday…' : 'Start scribbling…\n\nclient was driving home when the other vehicle…'} />}
        <div className="note-foot"><span>Anything goes. Ada will organize what is actually present.</span><div className="note-actions"><button className="menu-button" aria-label="Note actions" title="Note actions" aria-expanded={actionsOpen} onClick={()=>setActionsOpen(value=>!value)}><span className="hamburger-icon" aria-hidden="true"><i></i><i></i><i></i></span></button>{actionsOpen && <div className="actions-menu"><input ref={fileInput} className="scan-input" type="file" accept="image/*" capture="environment" onChange={e=>{const file=e.target.files?.[0]; if(file) { void handleScan(file); setActionsOpen(false) }}} /><button className="menu-item" onClick={()=>fileInput.current?.click()}>{scanState}</button><button className="menu-item menu-save" onClick={()=>{void handleSave(); setActionsOpen(false)}}>{saveState}</button><button className="menu-item" disabled={workspaceMode !== 'professional' || exportState !== 'idle'} onClick={async()=>{setExportState('docx'); setStatus('Preparing DOCX…'); try { await exportDocx(document); setStatus('DOCX saved to device') } catch (e) { setStatus('DOCX export failed: ' + (e as Error).message) } finally { setExportState('idle'); setActionsOpen(false) }}}>{exportState === 'docx' ? 'Preparing…' : 'Save as DOCX'}</button><button className="menu-item" disabled={workspaceMode !== 'professional' || exportState !== 'idle'} onClick={()=>{setExportState('pdf'); setStatus('Preparing PDF…'); try { exportPdf(document); setStatus('PDF saved to device') } catch (e) { setStatus('PDF export failed: ' + (e as Error).message) } finally { setExportState('idle'); setActionsOpen(false) }}}>{exportState === 'pdf' ? 'Preparing…' : 'Save as PDF'}</button><button className="menu-item" onClick={()=>{setNotes(''); setActionsOpen(false)}}>Clear</button></div>}</div></div>
      </section>
      <div className="divider" onPointerDown={(e)=>{e.currentTarget.setPointerCapture(e.pointerId); const move=(ev:PointerEvent)=>handlePointer(ev as unknown as React.PointerEvent<HTMLDivElement>); const up=()=>{e.currentTarget.removeEventListener('pointermove',move as any);e.currentTarget.removeEventListener('pointerup',up)};e.currentTarget.addEventListener('pointermove',move as any);e.currentTarget.addEventListener('pointerup',up)}}><span></span></div>
      <section className="pane document-pane">
        <div className="pane-head"><div><span className="eyebrow">02 · {workspaceMode==='quick' ? 'QUICK OUTPUT' : 'PROFESSIONAL DOCUMENT'}</span><h2>{workspaceMode==='quick' ? 'Quick Note' : document.title}</h2></div><div className="document-head-actions">{workspaceMode==='professional' && <button className="copy-button" type="button" disabled={copyState !== 'Copy to Clipboard'} onClick={async()=>{setCopyState('Copying…'); try { await copyDocumentToClipboard(document); setCopyState('Copied'); setStatus('Formatted document copied'); window.setTimeout(()=>setCopyState('Copy to Clipboard'),1800) } catch (e) { setCopyState('Copy failed'); setStatus('Copy failed: ' + (e as Error).message); window.setTimeout(()=>setCopyState('Copy to Clipboard'),2200) }}}>{copyState}</button>}<span className="live-dot">● LIVE</span></div></div>
        {workspaceMode==='professional' && profession==='doctor' && <div className="clinical-notice"><strong>{professionLocked === null ? 'Preview. Use fictional notes only. Do not enter real patient data.' : 'Documentation aid only. Not clinical advice. The clinician is responsible for the content.'}</strong>{professionLocked === null && <span>Documentation aid only. Not clinical advice. The clinician is responsible for the content.</span>}<small>Notes are sent to {document.provider_name} to generate the document.</small></div>}
        {workspaceMode==='professional' && document.needs_input.length > 0 && <div className="needs"><strong>Needs your input</strong>{document.needs_input.map(item => <button key={item.id + item.question} type="button" onClick={()=>{if(item.section_id){setFocused(item.section_id); window.requestAnimationFrame(()=>{const area=window.document.querySelector('[data-section-id="' + item.section_id + '"]') as HTMLTextAreaElement | null; area?.focus(); area?.scrollIntoView({behavior:'smooth',block:'center'})})}}}>{item.question}</button>)}</div>}
        {workspaceMode==='quick' ? <article className="document quick-output"><div className="doc-title">Quick Note</div><div className="doc-rule"></div><textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Your note will appear here." /><small>Plain output · no professional structure applied</small></article> : <article className="document">
          <div className="doc-title">{document.title}</div>
          <div className="doc-rule"></div>
          {document.sections.map(section => {
            const fieldWarnings = document.warnings.filter(warning => warning.section_id === section.id)
            const isLocked = lockedSections.has(section.id)
            return <section className={"doc-section " + (!section.content.trim() ? "is-empty" : "")} key={section.id}>
              <div className="field-head"><label>{section.label}</label><div className="field-meta">{fieldWarnings.map(warning => <span className="field-warning" key={warning.message}>{warning.message}</span>)}{isLocked ? <button type="button" className="field-lock" onClick={()=>unlockSection(section.id)} title="Unlock this field" aria-label={"Unlock " + section.label}>Locked · unlock</button> : !section.content.trim() ? <span className="field-empty-state">Empty</span> : null}</div></div>
              <textarea data-section-id={section.id} value={section.content} onFocus={()=>setFocused(section.id)} onBlur={()=>setFocused(null)} onChange={e=>{editSection(section.id,e.target.value); e.currentTarget.style.height='auto'; e.currentTarget.style.height=e.currentTarget.scrollHeight+'px'}} onInput={e=>{e.currentTarget.style.height='auto'; e.currentTarget.style.height=e.currentTarget.scrollHeight+'px'}} placeholder="Empty field" />
              {focusedSection===section.id && !isLocked && <small>Editing · changes lock this field against later AI updates</small>}
            </section>
          })}
        </article>}
          {workspaceMode==='professional' && document.unplaced.length > 0 && <div className="unplaced"><strong>Unplaced from your notes</strong>{document.unplaced.map((item, index)=><span key={index}>{item}</span>)}</div>}
          {workspaceMode==='professional' && document.warnings.length > 0 && <div className="warnings-summary"><strong>Review warnings</strong>{document.warnings.map((warning,index)=><span key={index}>{warning.message}</span>)}</div>}
      </section>
    </section>
    <footer><span>ada.            2026.            made with ❤️ in 🇳🇬.</span></footer>
    {historyOpen && <div className="history-backdrop" onClick={()=>setHistoryOpen(false)}>
      <aside className="history-panel" onClick={e=>e.stopPropagation()}>
        <div className="history-head"><div><span className="eyebrow">LOCAL STORAGE</span><h2>History</h2><p>Structured documents stay on this device.</p></div><button className="close-button" onClick={()=>setHistoryOpen(false)}>×</button></div>
        <div className="history-list">
          {history.length === 0 ? <div className="history-empty"><strong>No saved notes yet.</strong><span>Finish a note, then use Save Note.</span></div> : history.map(note => <article className="history-item" key={note.id}>
            <button className="history-open" onClick={()=>openSaved(note)}><span className="history-title">{note.document.title}</span><strong>{note.document.sections.find(section => section.content.trim())?.content.slice(0, 90) || 'Structured document saved'}</strong><small>{note.profession === 'doctor' ? 'Doctor' : 'Lawyer'} · {new Date(note.updatedAt).toLocaleString([], {day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}</small></button>
            <button className="delete-button" aria-label="Delete saved note" onClick={()=>removeSaved(note.id)}>Delete</button>
          </article>)}
        </div>
      </aside>
    </div>}
  </main>
}

function Root() { const [path, setPath] = useState(window.location.pathname); useEffect(() => { const onPop = () => setPath(window.location.pathname); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop) }, []); if (path === '/0.1') return <App />; if (path === '/waitlist') return <PublicPage waitlist />; return <PublicPage /> }

createRoot(document.getElementById('root')!).render(<React.StrictMode><Root/></React.StrictMode>)