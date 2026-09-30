import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import './styles.css'

type Profession = 'doctor' | 'lawyer'
type Section = { id: string; label: string; content: string }
type DocumentState = { title: string; sections: Section[]; needs_input: string[]; provider: string }
type SavedNote = { id: string; profession: Profession; document: DocumentState; createdAt: string; updatedAt: string }

const DB_NAME = 'ada-local';
const DB_VERSION = 2;
const STORE_NAME = 'notes';
const ADA_SUPABASE_URL = 'https://husahdwqvoboguaceerd.supabase.co';
const ADA_SUPABASE_KEY = 'sb_publishable_hxSlGSUqfrpQzunQ66m3EQ_PecORFor';
const PROFESSION_KEY = 'ada-profession';

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

async function joinWaitlist(email: string, profession: Profession): Promise<void> {
  const response = await fetch(ADA_SUPABASE_URL + '/rest/v1/waitlist', {
    method: 'POST', headers: { apikey: ADA_SUPABASE_KEY, Authorization: 'Bearer ' + ADA_SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ email: email.trim().toLowerCase(), profession }),
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

async function deleteLocalNote(id: string): Promise<void> {
  const db = await openNotesDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
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
  setFocused: (id: string | null) => void
}

const emptyDoc = (profession: Profession): DocumentState => profession === 'doctor'
  ? { title: 'Clinical Note', sections: [
      { id:'chief_complaint', label:'Chief Complaint', content:'' }, { id:'history', label:'History of Present Illness', content:'' },
      { id:'observations', label:'Observations / Vitals', content:'' }, { id:'assessment', label:'Assessment', content:'' }, { id:'plan', label:'Plan', content:'' }
    ], needs_input: [], provider:'ready' }
  : { title: 'Case Note', sections: [
      { id:'parties', label:'Parties', content:'' }, { id:'facts', label:'Facts / Incident Summary', content:'' },
      { id:'injuries', label:'Injuries / Damages', content:'' }, { id:'liability', label:'Liability / Issues', content:'' },
      { id:'evidence', label:'Supporting Information', content:'' }, { id:'next_steps', label:'Next Steps', content:'' }
    ], needs_input: [], provider:'ready' }

const useAda = create<Store>((set) => ({
  profession: 'doctor', notes: '', document: emptyDoc('doctor'), focusedSection: null,
  setProfession: (profession) => set({ profession, document: emptyDoc(profession) }),
  setNotes: (notes) => set({ notes }), setDocument: (document) => set({ document }),
  editSection: (id, content) => set(s => ({ document: { ...s.document, sections: s.document.sections.map(x => x.id === id ? {...x, content} : x) }})),
  setFocused: (focusedSection) => set({ focusedSection })
}))

function App() {
  const { profession, notes, document, focusedSection } = useAda()
  const setNotes = useAda(s=>s.setNotes), setProfession=useAda(s=>s.setProfession), setDocument=useAda(s=>s.setDocument)
  const setFocused=useAda(s=>s.setFocused), editSection=useAda(s=>s.editSection)
  const [status, setStatus] = useState('Ready')
  const [waitlistOpen, setWaitlistOpen] = useState(false)
  const [waitlistEmail, setWaitlistEmail] = useState('')
  const [waitlistState, setWaitlistState] = useState('Join waitlist')
  const [professionLocked, setProfessionLocked] = useState<Profession | null>(null)
  const [split, setSplit] = useState(50)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<SavedNote[]>([])
  const [saveState, setSaveState] = useState('Save Note')
  const [scanState, setScanState] = useState('Scan note')
  const [actionsOpen, setActionsOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
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
          useAda.setState({ profession: parsed.profession, notes: '', document: parsed.document })
          localStorage.setItem('ada-current-draft', JSON.stringify({ profession: parsed.profession, document: parsed.document }))
          setStatus('Structured document restored from this device')
        }
      }
    } catch {}
  }, [])

  useEffect(() => {
    try { localStorage.setItem('ada-current-draft', JSON.stringify({ profession, document })) } catch {}
  }, [profession, notes, document])

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

  async function handleWaitlist() {
    if (!waitlistEmail.trim()) { setWaitlistState('Enter email'); return }
    setWaitlistState('Joining…')
    try { await joinWaitlist(waitlistEmail, profession); setWaitlistState('You’re on the list'); setWaitlistEmail('') }
    catch { setWaitlistState('Could not join') }
    window.setTimeout(() => setWaitlistState('Join waitlist'), 2200)
  }

  function openSaved(note: SavedNote) {
    useAda.setState({ profession: note.profession, notes: '', document: note.document, focusedSection: null })
    setHistoryOpen(false)
    setStatus('Opened from this device')
  }

  async function removeSaved(id: string) {
    await deleteLocalNote(id)
    setHistory(await listLocalNotes())
  }

  useEffect(() => {
    window.clearTimeout(timer.current)
    if (!notes.trim()) { setDocument(emptyDoc(profession)); setStatus('Ready'); return }
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
        const next = await r.json() as DocumentState & { profession: Profession }
        setDocument(next); setStatus(next.provider === 'local-demo' ? 'Local demo engine' : `Live: ${next.provider}`)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setStatus('Could not update: ' + (e as Error).message)
      }
    }, 650)
    return () => window.clearTimeout(timer.current)
  }, [notes, profession])

  function handlePointer(e: React.PointerEvent<HTMLDivElement>) {
    const parent = e.currentTarget.parentElement?.getBoundingClientRect(); if (!parent) return
    const pct = Math.max(30, Math.min(70, ((e.clientX-parent.left)/parent.width)*100)); setSplit(pct)
  }

  return <main className="app">
    <header className="topbar">
      <div className="brand"><div><strong>ada</strong><span>write naturally. structure professionally.</span></div></div>
      <div className="mode"><span className="locked-mode">{profession==='doctor' ? 'Doctor' : 'Lawyer'} · locked</span></div>
      <button className="waitlist-button" onClick={()=>setWaitlistOpen(true)}>Join waitlist</button>
      <div className="status"><i></i>{status}</div>
    </header>
    <section className="workspace" style={{gridTemplateColumns:`${split}% 8px ${100-split}%`}}>
      <section className="pane notes-pane">
        <div className="pane-head"><div><span className="eyebrow">01 · YOUR NOTES</span><h2>Write however you think.</h2></div><div className="head-actions"><span className="hint">{notes.length.toLocaleString()} chars</span><button className="history-button" onClick={()=>setHistoryOpen(true)}>History{history.length ? <b>{history.length}</b> : null}</button></div></div>
        <textarea autoFocus value={notes} onChange={e=>setNotes(e.target.value)} placeholder={profession==='doctor' ? 'Start scribbling…\n\npatient came in complaining of chest pain since yesterday…' : 'Start scribbling…\n\nclient was driving home when the other vehicle…'} />
        <div className="note-foot"><span>Anything goes. Ada will organize what is actually present.</span><div className="note-actions"><button className="menu-button" aria-expanded={actionsOpen} onClick={()=>setActionsOpen(value=>!value)}>Menu</button>{actionsOpen && <div className="actions-menu"><input ref={fileInput} className="scan-input" type="file" accept="image/*" capture="environment" onChange={e=>{const file=e.target.files?.[0]; if(file) { void handleScan(file); setActionsOpen(false) }}} /><button className="menu-item" onClick={()=>fileInput.current?.click()}>{scanState}</button><button className="menu-item menu-save" onClick={()=>{void handleSave(); setActionsOpen(false)}}>{saveState}</button><button className="menu-item" onClick={()=>{setNotes(''); setActionsOpen(false)}}>Clear</button></div>}</div></div>
      </section>
      <div className="divider" onPointerDown={(e)=>{e.currentTarget.setPointerCapture(e.pointerId); const move=(ev:PointerEvent)=>handlePointer(ev as unknown as React.PointerEvent<HTMLDivElement>); const up=()=>{e.currentTarget.removeEventListener('pointermove',move as any);e.currentTarget.removeEventListener('pointerup',up)};e.currentTarget.addEventListener('pointermove',move as any);e.currentTarget.addEventListener('pointerup',up)}}><span></span></div>
      <section className="pane document-pane">
        <div className="pane-head"><div><span className="eyebrow">02 · STRUCTURED DOCUMENT</span><h2>{document.title}</h2></div><span className="live-dot">● LIVE</span></div>
        {document.needs_input.length > 0 && <div className="needs"><strong>Needs input</strong><span>{document.needs_input.join(' · ')}</span></div>}
        <article className="document">
          <div className="doc-title">{document.title}</div>
          <div className="doc-rule"></div>
          {document.sections.map(section => <section className="doc-section" key={section.id}>
            <label>{section.label}</label>
            <textarea value={section.content} onFocus={()=>setFocused(section.id)} onBlur={()=>setFocused(null)} onChange={e=>editSection(section.id,e.target.value)} placeholder="No information provided." />
            {focusedSection===section.id && <small>Editing · your changes are protected while focused</small>}
          </section>)}
        </article>
      </section>
    </section>
    <footer><span>Ada 0.1 · human review remains in control</span><span>Documents stay on this device · raw notes stay with Ada</span></footer>
    {waitlistOpen && <div className="waitlist-backdrop" onClick={()=>setWaitlistOpen(false)}>
      <section className="waitlist-card" onClick={e=>e.stopPropagation()}>
        <button className="close-button" onClick={()=>setWaitlistOpen(false)}>×</button>
        <span className="eyebrow">EARLY ACCESS</span><h2>Ada is opening soon.</h2>
        <p>Join the waitlist for early access to the professional note-to-document workspace.</p>
        <div className="waitlist-profession"><strong>{profession==='doctor' ? 'Doctor' : 'Lawyer'}</strong><span>Your workspace is locked to this role.</span></div>
        <input className="waitlist-input" type="email" value={waitlistEmail} onChange={e=>setWaitlistEmail(e.target.value)} placeholder="you@example.com" />
        <button className="waitlist-submit" onClick={handleWaitlist}>{waitlistState}</button>
      </section>
    </div>}
    {professionLocked === null && <div className="lock-backdrop">
      <section className="lock-card"><span className="eyebrow">ADA PROFESSIONAL WORKSPACE</span><h2>Choose your profession.</h2><p>Ada locks each workspace to one professional role. You cannot switch between Doctor and Lawyer inside the workspace.</p><div className="lock-options"><button onClick={()=>chooseProfession('doctor')}><strong>Doctor</strong><span>Clinical documentation</span></button><button onClick={()=>chooseProfession('lawyer')}><strong>Lawyer</strong><span>Legal case documentation</span></button></div></section>
    </div>}
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

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)