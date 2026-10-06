import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import { jsPDF } from 'jspdf'
import { PaddleOCR } from '@paddleocr/paddleocr-js'
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
const PROFESSION_KEY = 'ada-profession';
const ONBOARDED_KEY = 'ada-onboarded';
const USAGE_KEY = 'ada-usage-v1';
const FREE_LIMIT = 10;
type UsageKind = 'quick' | 'professional' | 'scan';
function usageMonth(): string { return new Date().toISOString().slice(0, 7) }
function readUsage(): Record<UsageKind, number> { try { const raw = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); if (raw.month !== usageMonth()) return { quick: 0, professional: 0, scan: 0 }; return { quick: Number(raw.quick) || 0, professional: Number(raw.professional) || 0, scan: Number(raw.scan) || 0 } } catch { return { quick: 0, professional: 0, scan: 0 } } }
function saveUsage(usage: Record<UsageKind, number>) { localStorage.setItem(USAGE_KEY, JSON.stringify({ month: usageMonth(), ...usage })) }
function isProfessionalPlan(): boolean { return localStorage.getItem('ada-plan') === 'professional' }
function consumeFreeUse(kind: UsageKind): boolean { if (isProfessionalPlan()) return true; const usage = readUsage(); if (usage[kind] >= FREE_LIMIT) return false; usage[kind] += 1; saveUsage(usage); return true }

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

let paddleOcrPromise: Promise<any> | null = null;

async function runPaddleOcr(file: File): Promise<string> {
  if (!paddleOcrPromise) {
    paddleOcrPromise = PaddleOCR.create({
      lang: 'en',
      ocrVersion: 'PP-OCRv5',
      ortOptions: { backend: 'auto' },
    });
  }
  const ocr = await paddleOcrPromise;
  if (!ocr) throw new Error('PaddleOCR could not initialize in this browser');
  const results = await ocr.predict(file);
  return results
    .flatMap((result: any) => result?.items ?? [])
    .map((item: any) => {
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      const score = Number(item?.score ?? item?.confidence ?? 1);
      return text && score >= 0.25 ? text : '';
    })
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

type SpeechRecognitionInstance = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: any) => void) | null
  onend: (() => void) | null
  onerror: ((event: any) => void) | null
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  const w = window as any
  return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as SpeechRecognitionConstructor | null
}

function localStructureDocument(profession: Profession, notes: string): DocumentState {
  const sentences = notes.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)
  const bucket = (keywords: string[]) => sentences.filter(s => keywords.some(k => s.toLowerCase().includes(k))).join(' ')
  if (profession === 'doctor') {
    const used = new Set<string>()
    const pick = (keywords: string[]) => {
      const found = sentences.filter(s => keywords.some(k => s.toLowerCase().includes(k)))
      found.forEach(x => used.add(x))
      return found.join(' ')
    }
    const sections = [
      {id:'chief_complaint',label:'Chief Complaint',content:pick(['complain','presenting','came in','here for','pain','headache','cough'])},
      {id:'history',label:'History of Present Illness',content:pick(['since','for ','worse','better','history','reports','started','yesterday','today'])},
      {id:'history_social_family',label:'Past / Social / Family History',content:pick(['past medical','family history','social history','smokes','smoking','alcohol'])},
      {id:'allergies',label:'Allergies',content:pick(['allerg','no known'])},
      {id:'observations',label:'Observations / Vitals',content:pick(['bp','blood pressure','pulse','temperature','temp','weight','height','vital'])},
      {id:'examination',label:'Examination Findings',content:pick(['exam','examination','tender','swelling','lungs','heart sounds'])},
      {id:'investigations',label:'Investigations',content:pick(['x-ray','xray','mri','ct ','lab','test result','investigation'])},
      {id:'assessment',label:'Assessment',content:pick(['assessment','diagnos','impression'])},
      {id:'plan',label:'Plan',content:pick(['plan','prescrib','review','refer','start','continue','give'])},
      {id:'follow_up',label:'Follow-up',content:pick(['follow-up','follow up','return','revisit'])},
    ]
    const unplaced = sentences.filter(s => !used.has(s))
    return normalizeDocument({title:'Clinical Note',sections,needs_input:[],warnings:[],unplaced,provider:'local-device',provider_name:'on-device mode'})
  }
  const used = new Set<string>()
  const pick = (keywords: string[]) => {
    const found = sentences.filter(s => keywords.some(k => s.toLowerCase().includes(k)))
    found.forEach(x => used.add(x)); return found.join(' ')
  }
  const sections = [
    {id:'parties',label:'Parties',content:pick(['plaintiff','defendant','client','company','insurer','driver'])},
    {id:'facts',label:'Facts / Incident Summary',content:pick(['incident','accident','happened','collision','drove','driving','occurred'])},
    {id:'injuries',label:'Injuries / Damages',content:pick(['injury','injured','damage','pain','hospital','medical','loss'])},
    {id:'liability',label:'Liability / Issues',content:pick(['liable','liability','fault','negligence','issue','claim'])},
    {id:'authorities',label:'Authorities',content:pick(['act ','section ','case ','v.','regulation','statute'])},
    {id:'evidence',label:'Supporting Information',content:pick(['witness','photo','police','report','document','record','evidence'])},
    {id:'next_steps',label:'Next Steps',content:pick(['next','file','send','review','draft','follow up','meeting'])},
  ]
  return normalizeDocument({title:'Case Note',sections,needs_input:[],warnings:[],unplaced:sentences.filter(s=>!used.has(s)),provider:'local-device',provider_name:'on-device mode'})
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

function PublicPage() {
  const start = () => { if (!localStorage.getItem(PROFESSION_KEY)) localStorage.setItem(PROFESSION_KEY, 'doctor'); localStorage.setItem(ONBOARDED_KEY, 'true'); goTo('/0.1') }
  return <main className="public-page ada-home">
    <header className="public-top"><button className="public-brand" onClick={()=>goTo('/')}><strong>Ada</strong></button><nav className="home-nav"><a href="#how-it-works">How it works</a><a href="#professionals">For professionals</a><a href="#pricing">Pricing</a><button onClick={start}>Open Ada </button></nav></header>
    <section className="home-hero"><div className="hero-copy"><span className="eyebrow">DOCUMENTATION WITHOUT THE INTERRUPTION</span><h1>Be present with your client. <em className="accent-heading">Let Ada handle the record.</em></h1><p>The dual-pane workspace for doctors and lawyers. Scribble freely, upload rough documents, or scan handwritten notes in the left pane. Turn raw input into structured professional documentation in the right pane.</p><div className="hero-actions"><button className="home-primary" onClick={start}>Start documenting free <span></span></button><a href="#how-it-works">See how it works</a></div><div className="hero-proof"><span>✳ Free-form capture</span><span>◉ Local browser history</span><span>⌁ Editable output</span></div></div>
    <div className="hero-product"><div className="product-topline"><span><i/> ADA WORKSPACE</span><span>STRUCTURED DRAFT</span></div><div className="product-split"><div className="product-input"><small>01 / CAPTURE</small><b>Consultation notes</b><p>Patient reports recurring headaches for 3 weeks. Worse in the morning. No known allergies. BP 128/82. Review medication history and schedule follow-up.</p><div className="scribble-lines">••• rough notes<br/>••• observations<br/>••• next steps</div></div><div className="product-output"><small>02 / STRUCTURED RECORD</small><b>Clinical Note</b><label>CHIEF COMPLAINT</label><p>Recurring headaches for three weeks.</p><label>OBSERVATIONS</label><p>Blood pressure: 128/82 mmHg.</p><label>PLAN</label><p>Review medication history. Arrange follow-up.</p><span className="review-tag">Review and approve before use</span></div></div><div className="product-bottom"><span>Editable draft</span><span>Local history · Export-ready</span></div></div></section>
    <section className="home-problem"><div><span className="eyebrow">THE DOCUMENTATION GAP</span><h2><span className="accent-heading">The conversation ends. The paperwork doesn't.</span></h2></div><div className="problem-columns"><article><span>01 / THE REALITY</span><h3>You can’t fill out a form while listening.</h3><p>When a patient describes complex symptoms or a client recounts a timeline, your brain is in analysis mode, not data-entry mode. Rigid fields interrupt focus and rapport.</p></article><article><span>02 / THE AFTER-HOURS TAX</span><h3>Then the reconstruction starts after the appointment.</h3><p>You scribble on paper, photograph referrals, or type chaotic fragments. Later, you reconstruct them into SOAP notes or case memos. That is time pulled away from rest and the work that matters.</p></article></div></section>
    <section className="home-how" id="how-it-works"><div className="section-intro"><span className="eyebrow">A TWO-PANE WORKFLOW</span><h2><span className="accent-heading">Two panes. One workflow. Less friction.</span></h2><p>Capture first. Organize second. Stay with the person in front of you.</p></div><div className="how-grid"><article><span className="step-number">01</span><h3>The Capture Zone</h3><p>Type quickly, scribble, or add a document. Bring in handwritten referrals, rough clauses, and existing PDFs. Focus on getting the facts down, not polishing the format.</p><ul><li>Free-form typing and handwriting</li><li>Image and document input</li><li>Capture details in your own order</li></ul></article><article><span className="step-number">02</span><h3>The Structured Record</h3><p>Ada organizes supported input into a professional draft. Review sections, correct details, and export when ready.</p><ul><li>Clinical and case-oriented structure</li><li>Editable sections and review prompts</li><li>Document export workflows</li></ul></article></div><div className="video-placeholder"><div className="play-mark"></div><span>WORKFLOW PREVIEW</span><p>See rough notes become a structured document</p><small>Product walkthrough video can be embedded here.</small></div></section>
    <section className="home-professions" id="professionals"><div className="section-intro"><span className="eyebrow">BUILT FOR HIGH-STAKES PROFESSIONALS</span><h2><span className="accent-heading">Different disciplines. One documentation problem.</span></h2></div><div className="profession-grid"><article><div className="profession-icon">＋</div><span className="eyebrow">FOR DOCTORS</span><h3>From chaos to SOAP notes.</h3><p>Shape consultation notes and scanned referrals into structured clinical summaries, discharge drafts, and referral letters.</p><div className="benefit"><b>Clinical workflow support</b><span>SOAP-oriented structure, editable drafts, and local browser history.</span></div><button onClick={start}>Open Ada for Doctors</button></article><article><div className="profession-icon">§</div><span className="eyebrow">FOR LAWYERS</span><h3>From intake to case memo.</h3><p>Capture a client’s narrative, organize dates and facts, and shape rough material into case briefs, engagement drafts, and time-recording notes.</p><div className="benefit"><b>Case-focused organization</b><span>Structured notes, editable records, and export workflows.</span></div><button onClick={start}>Open Ada for Lawyers</button></article></div></section>
    <section className="home-trust"><div><span className="eyebrow">YOUR NOTES, YOUR DEVICE</span><h2><span className="accent-heading">Local-first workspace. Clear data boundaries.</span></h2><p>Saved document history is stored in your browser on this device. Submitted content is sent to the configured AI processing service to generate a response. Do not enter identifiable or confidential information until the provider's processing and retention terms have been reviewed. Ada does not need a server-side notes database for local history.</p></div><div className="trust-points"><article><b>Browser-based history</b><span>Saved records stay in local browser storage unless you export them.</span></article><article><b>Review before relying</b><span>Ada assists with structure. Professionals remain responsible for verification, decisions, and approval.</span></article><article><b>Privacy claims grounded in implementation</b><span>AI provider processing, retention, and applicable compliance status should be verified before sensitive use.</span></article></div></section>
    <section className="home-pricing" id="pricing"><div className="section-intro"><span className="eyebrow">SIMPLE PRICING</span><h2><span className="accent-heading">An investment that can pay for itself in one saved hour.</span></h2><p>Start with Lite. Upgrade when Ada becomes part of your daily workflow.</p></div><div className="pricing-grid"><article><span className="eyebrow">ADA LITE</span><h3>$0 <small>/ month</small></h3><p>For trying the workflow.</p><ul><li>Dual-pane workspace</li><li>10 Quick Note uses per month</li><li>10 Professional Document uses per month</li><li>10 Scanning/OCR uses per month</li><li>Unlimited Scribble</li><li>Copy to clipboard</li><li>Local browser history</li></ul><button onClick={start}>Start free</button></article><article className="pricing-pro"><span className="eyebrow">ADA PROFESSIONAL</span><h3>$19 <small>/ ₦28,000 per month</small></h3><p>Or $190 / ₦280,000 yearly.</p><ul><li>Everything in Lite</li><li>Unlimited Quick Note</li><li>Unlimited Professional Document</li><li>Unlimited Scanning/OCR</li><li>Unlimited Scribble</li><li>Professional templates</li><li>PDF, Word, and rich-text export</li><li>Priority founder support</li></ul><button onClick={start}>Start with Ada</button><small className="pricing-note">Plan limits and billing availability should be confirmed before checkout.</small></article></div><div className="roi-copy"><h3>Why pay for Ada?</h3><p>Your subscription supports AI compute and continued development of profession-specific templates. If Ada saves even 15 minutes of documentation time each week, that time can compound across your working year.</p><p><strong>Professional trial:</strong> 14 days with no card required.</p></div></section>
    <section className="home-final"><span className="eyebrow">CLOSE THE DAY WITH YOUR WORK DONE</span><h2>Reclaim your evening hours.</h2><p>Stay present in the conversation. Let Ada help shape the record.</p><button onClick={start}>Start documenting now</button></section><footer><span>Ada. &nbsp; 2026. &nbsp; Made with ❤️ in 🇳🇬.</span><span>Documentation support, not a substitute for professional judgment.</span></footer>
  </main>
}
function App() {
  const { profession, notes, document, focusedSection, lockedSections } = useAda()
  const setNotes = useAda(s=>s.setNotes), setProfession=useAda(s=>s.setProfession), setDocument=useAda(s=>s.setDocument)
  const setFocused=useAda(s=>s.setFocused), editSection=useAda(s=>s.editSection), unlockSection=useAda(s=>s.unlockSection)
  const [status, setStatus] = useState('Ready')
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('professional')
  const [professionLocked, setProfessionLocked] = useState<Profession>('doctor')
  const [split, setSplit] = useState(50)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<SavedNote[]>([])
  const [saveState, setSaveState] = useState('Save Note')
  const [scanState, setScanState] = useState('Scan note')
  const [actionsOpen, setActionsOpen] = useState(false)
  const [exportState, setExportState] = useState<'idle' | 'docx' | 'pdf'>('idle')
  const [copyState, setCopyState] = useState('Copy to Clipboard')
  const [gateMessage, setGateMessage] = useState('')
  const [usage, setUsage] = useState<Record<UsageKind, number>>(readUsage())
  const [privateMode, setPrivateMode] = useState(() => localStorage.getItem('ada-private-mode') === 'true')
  const [voiceState, setVoiceState] = useState<'idle' | 'listening'>('idle')
  const speechRecognition = useRef<SpeechRecognitionInstance | null>(null)
  const generationCharged = useRef(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const scribbleCanvas = useRef<HTMLCanvasElement | null>(null)
  const scribbleStrokes = useRef<Array<Array<{x:number;y:number}>>>([])
  const scribbleCurrent = useRef<Array<{x:number;y:number}> | null>(null)
  const [scribbleMode, setScribbleMode] = useState(false)
  const [scribbleState, setScribbleState] = useState('Convert to notes')
  const timer = useRef<number | undefined>(undefined)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    const goOnline = () => { setIsOnline(true); setStatus('Online · ready') }
    const goOffline = () => { setIsOnline(false); setPrivateMode(true); localStorage.setItem('ada-private-mode', 'true'); setStatus('Offline · private mode') }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
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

  function refreshUsage() { setUsage(readUsage()) }
  function requireFreeUse(kind: UsageKind, label: string): boolean { const ok = consumeFreeUse(kind); refreshUsage(); if (!ok) { setGateMessage(`Free plan limit reached: ${label} is limited to 10 uses per month. Upgrade to Professional for unlimited use.`); return false } return true }


  function togglePrivateMode() {
    setPrivateMode(value => {
      const next = !value
      localStorage.setItem('ada-private-mode', String(next))
      setStatus(next ? 'Private mode · on-device structuring' : 'Online AI mode')
      return next
    })
  }

  function toggleVoice() {
    if (voiceState === 'listening') {
      speechRecognition.current?.stop()
      setVoiceState('idle')
      setStatus('Voice stopped')
      return
    }
    const Recognition = getSpeechRecognition()
    if (!Recognition) {
      setStatus('Voice input is not supported in this browser')
      return
    }
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-NG'
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results as any[]).slice(event.resultIndex || 0)
        .map((result: any) => result?.[0]?.transcript || '').join(' ').trim()
      if (transcript) {
        setNotes((useAda.getState().notes.trim() ? useAda.getState().notes.trim() + ' ' : '') + transcript)
        setStatus('Voice captured')
      }
    }
    recognition.onend = () => { speechRecognition.current = null; setVoiceState('idle') }
    recognition.onerror = (event: any) => { speechRecognition.current = null; setVoiceState('idle'); setStatus('Voice error: ' + String(event?.error || 'unknown')) }
    speechRecognition.current = recognition
    setVoiceState('listening')
    setStatus('Listening… speak naturally')
    recognition.start()
  }

  useEffect(() => () => speechRecognition.current?.stop(), [])
  async function convertScribbleToNotes() {
    const canvas = scribbleCanvas.current
    if (!canvas || scribbleStrokes.current.length === 0) {
      setScribbleState('Write something first')
      window.setTimeout(() => setScribbleState('Convert to notes'), 1600)
      return
    }
    setScribbleState('Reading…')
    setStatus('Converting handwriting…')
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
      if (!requireFreeUse('scan', 'Scanning/OCR')) return
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
      await saveLocalNote(saved)
      const next = await listLocalNotes()
      setHistory(next)
      setSaveState('Saved to Ada + device')
      window.setTimeout(() => setSaveState('Save Note'), 1800)
    } catch {
      setSaveState('Could not save locally')
    }
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
    if (profession !== 'doctor') {
      localStorage.setItem(PROFESSION_KEY, 'doctor')
      setProfession('doctor')
    }
  }, [])

  function startNewEncounter() {
    useAda.setState({ profession: 'doctor', notes: '', document: emptyDoc('doctor'), focusedSection: null, lockedSections: new Set<string>() })
    setStatus('New clinical note')
  }

  function markReviewComplete() {
    setStatus(document.needs_input.length ? 'Reviewed · resolve the remaining questions before filing' : 'Reviewed · ready to export')
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
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', resizeScribbleCanvas)
    }
  }, [scribbleMode])

  useEffect(() => {
    window.clearTimeout(timer.current)
    if (!notes.trim()) generationCharged.current = false
    if (!notes.trim() || workspaceMode === 'quick') {
      if (!notes.trim() && workspaceMode === 'professional') { setDocument(emptyDoc(profession)); useAda.setState({ lockedSections: new Set<string>() }) }
      if (!notes.trim()) setStatus('Ready')
      return
    }
    timer.current = window.setTimeout(async () => {
      if (!generationCharged.current) { if (!requireFreeUse('professional', 'Professional Document')) return; generationCharged.current = true }
      request.current?.abort(); request.current = new AbortController()
      const localDraft = localStructureDocument(profession, notes)
      const currentLocal = useAda.getState()
      const mergedLocal = { ...localDraft, sections: localDraft.sections.map(section => { const currentSection = currentLocal.document.sections.find(item => item.id === section.id); return currentLocal.lockedSections.has(section.id) && currentSection ? currentSection : section }) }
      setDocument(mergedLocal)
      setStatus(privateMode || !isOnline ? 'Private mode · on-device structuring' : 'Local draft · refining online…')
      try {
        if (privateMode || !isOnline) {
          return
        }
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
  }, [notes, profession, workspaceMode, privateMode, isOnline])

  function handlePointer(e: React.PointerEvent<HTMLDivElement>) {
    const parent = e.currentTarget.parentElement?.getBoundingClientRect(); if (!parent) return
    const pct = Math.max(30, Math.min(70, ((e.clientX-parent.left)/parent.width)*100)); setSplit(pct)
  }

  return <main className="app">
    <header className="topbar">
      <div className="brand"><div><strong>Ada</strong><span>Clinical Documentation</span></div></div>
      <div className="workspace-title">Clinical Documentation</div>
      <div className="workspace-controls">
        <button type="button" className={privateMode ? 'private-toggle active' : 'private-toggle'} onClick={togglePrivateMode} title="Private mode keeps structuring on this device and does not call the AI API">◉ {privateMode ? 'Private' : 'Online AI'}</button>
        <span className="usage-pill">{isProfessionalPlan() ? 'Professional · unlimited' : 'Free · ' + usage.professional + '/10 docs'}</span>
      </div>
      <div className="status"><i></i>{isOnline ? status : "Offline · Private mode"}</div>
    </header>
    <section className="workspace" style={{gridTemplateColumns:`${split}% 8px ${100-split}%`}}>
      <section className="pane notes-pane">
        <div className="pane-head"><div><span className="eyebrow">01 · CAPTURE</span><h2 className="notes-heading">Write however you think.</h2></div><div className="head-actions"><span className="hint">{notes.length.toLocaleString()} chars</span><button className="history-button" onClick={()=>setHistoryOpen(true)}>History{history.length ? <b>{history.length}</b> : null}</button></div></div>
        <div className="notes-input-mode"><button type="button" className={!scribbleMode ? 'active' : ''} onClick={()=>setScribbleMode(false)}>Type</button><button type="button" className={scribbleMode ? 'active' : ''} onClick={()=>{setScribbleMode(true); window.requestAnimationFrame(resizeScribbleCanvas)}}>Scribble</button><button type="button" className={voiceState === 'listening' ? 'voice-button listening' : 'voice-button'} onClick={toggleVoice}>{voiceState === 'listening' ? '● Listening…' : '🎙 Voice'}</button></div>
        {scribbleMode ? <div className="scribble-wrap">
          <div className="scribble-toolbar"><span>Use Apple Pencil, stylus, or finger.</span><div><button type="button" onClick={undoScribble}>Undo</button><button type="button" onClick={clearScribble}>Clear</button><button type="button" className="scribble-convert" onClick={()=>{void convertScribbleToNotes()}}>{scribbleState}</button></div></div>
          <canvas ref={scribbleCanvas} className="scribble-canvas" onPointerDown={startScribble} onPointerMove={moveScribble} onPointerUp={endScribble} onPointerCancel={endScribble} aria-label="Handwriting input area" />
          <small className="scribble-note">Handwriting is converted into your notes. Ada structures the converted text, not the drawing itself.</small>
        </div> : <textarea autoFocus value={notes} onChange={e=>{const value=e.target.value; if (workspaceMode==='quick' && !notes.trim() && value.trim() && !requireFreeUse('quick','Quick Note')) return; setNotes(value)}} placeholder={profession==='doctor' ? 'Start scribbling…\n\npatient came in complaining of chest pain since yesterday…' : 'Start scribbling…\n\nclient was driving home when the other vehicle…'} />}
        <div className="note-foot"><span>{isOnline ? 'Draft · saved locally' : 'Offline · saved locally'}</span><div className="note-actions"><button className="menu-button" aria-label="Note actions" title="Note actions" aria-expanded={actionsOpen} onClick={()=>setActionsOpen(value=>!value)}><span className="hamburger-icon" aria-hidden="true"><i></i><i></i><i></i></span></button>{actionsOpen && <div className="actions-menu"><input ref={fileInput} className="scan-input" type="file" accept="image/*" capture="environment" onChange={e=>{const file=e.target.files?.[0]; if(file) { void handleScan(file); setActionsOpen(false) }}} /><button className="menu-item" onClick={()=>fileInput.current?.click()}>{scanState}</button><button className="menu-item menu-save" onClick={()=>{void handleSave(); setActionsOpen(false)}}>{saveState === 'Save Note' ? 'Save Draft' : saveState}</button><button className="menu-item" disabled={workspaceMode !== 'professional' || exportState !== 'idle' || !isProfessionalPlan()} title={!isProfessionalPlan() ? 'Professional plan required' : undefined} onClick={async()=>{setExportState('docx'); setStatus('Preparing DOCX…'); try { await exportDocx(document); setStatus('DOCX saved to device') } catch (e) { setStatus('DOCX export failed: ' + (e as Error).message) } finally { setExportState('idle'); setActionsOpen(false) }}}>{exportState === 'docx' ? 'Preparing…' : 'Save as DOCX'}</button><button className="menu-item" disabled={workspaceMode !== 'professional' || exportState !== 'idle' || !isProfessionalPlan()} title={!isProfessionalPlan() ? 'Professional plan required' : undefined} onClick={()=>{setExportState('pdf'); setStatus('Preparing PDF…'); try { exportPdf(document); setStatus('PDF saved to device') } catch (e) { setStatus('PDF export failed: ' + (e as Error).message) } finally { setExportState('idle'); setActionsOpen(false) }}}>{exportState === 'pdf' ? 'Preparing…' : 'Save as PDF'}</button><button className="menu-item" onClick={()=>{setNotes(''); setActionsOpen(false)}}>Clear</button></div>}</div></div>
      </section>
      <div className="divider" onPointerDown={(e)=>{e.currentTarget.setPointerCapture(e.pointerId); const move=(ev:PointerEvent)=>handlePointer(ev as unknown as React.PointerEvent<HTMLDivElement>); const up=()=>{e.currentTarget.removeEventListener('pointermove',move as any);e.currentTarget.removeEventListener('pointerup',up)};e.currentTarget.addEventListener('pointermove',move as any);e.currentTarget.addEventListener('pointerup',up)}}><span></span></div>
      <section className="pane document-pane">
        <div className="pane-head"><div><span className="eyebrow">02 · CLINICAL RECORD</span><h2>{document.title}</h2></div><div className="document-head-actions">{<button className="copy-button" type="button" disabled={copyState !== 'Copy to Clipboard'} onClick={async()=>{setCopyState('Copying…'); try { await copyDocumentToClipboard(document); setCopyState('Copied'); setStatus('Formatted document copied'); window.setTimeout(()=>setCopyState('Copy to Clipboard'),1800) } catch (e) { setCopyState('Copy failed'); setStatus('Copy failed: ' + (e as Error).message); window.setTimeout(()=>setCopyState('Copy to Clipboard'),2200) }}}>{copyState}</button>}<span className="live-dot">● LIVE</span></div></div>
        <div className="clinical-notice"><strong>{professionLocked === null ? 'Preview. Use fictional notes only. Do not enter real patient data.' : 'Documentation aid only. Not clinical advice. The clinician is responsible for the content.'}</strong>{professionLocked === null && <span>Documentation aid only. Not clinical advice. The clinician is responsible for the content.</span>}<small>{privateMode ? 'Private mode: notes are structured on this device. No AI request is made.' : `Notes are sent to ${document.provider_name} to generate the document.`}</small></div>
        {document.needs_input.length > 0 && <div className="needs"><strong>Needs your input</strong>{document.needs_input.map(item => <button key={item.id + item.question} type="button" onClick={()=>{if(item.section_id){setFocused(item.section_id); window.requestAnimationFrame(()=>{const area=window.document.querySelector('[data-section-id="' + item.section_id + '"]') as HTMLTextAreaElement | null; area?.focus(); area?.scrollIntoView({behavior:'smooth',block:'center'})})}}}>{item.question}</button>)}</div>}
        <article className="document">
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
        </article>
          {document.unplaced.length > 0 && <div className="unplaced"><strong>Unplaced from your notes</strong>{document.unplaced.map((item, index)=><span key={index}>{item}</span>)}</div>}
          {document.warnings.length > 0 && <div className="warnings-summary"><strong>Review warnings</strong>{document.warnings.map((warning,index)=><span key={index}>{warning.message}</span>)}</div>}

      </section>
    </section>
    <footer><span>Ada. &nbsp; 2026. &nbsp; made with ❤️ in 🇳🇬.</span><span className="footer-privacy">{privateMode ? 'Private mode · on-device' : 'AI mode · provider processing applies'}</span></footer>
    {gateMessage && <div className="lock-backdrop" onClick={()=>setGateMessage('')}><div className="lock-card" onClick={e=>e.stopPropagation()}><span className="eyebrow">ADA PROFESSIONAL</span><h2>Professional feature</h2><p>{gateMessage}</p><div className="lock-options"><button onClick={()=>{setGateMessage(''); goTo('/#pricing')}}><strong>View Professional</strong><span>Unlimited usage and professional exports.</span></button><button onClick={()=>setGateMessage('')}><strong>Keep using Free</strong><span>10 uses per feature each month.</span></button></div></div></div>}
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

function Root() { const [path, setPath] = useState(window.location.pathname); useEffect(() => { const onPop = () => setPath(window.location.pathname); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop) }, []); if (path === '/0.1') return <App />; return <PublicPage /> }

createRoot(document.getElementById('root')!).render(<React.StrictMode><Root/></React.StrictMode>)