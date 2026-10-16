# Ada — universal, personalized AI documentation workspace

Ada converts raw notes — typed, scribbled, spoken, photographed — into structured,
editable professional documents. Built on the original two-pane note-to-document
loop (0.1) and extended into a universal, persona-driven workspace.

Write naturally on the left. Ada structures the professional document on the right.
Human editing is first-class: locked sections survive every subsequent pass.

## Architecture

- **Frontend**: React + Vite + TypeScript, plain CSS, onboarding wizard,
  template-aware workspace, local draft structuring fallback, IndexedDB note history,
  draft restore, private (on-device) mode.
- **Backend**: FastAPI, universal structuring engine
  (`app/structuring.py`), template registry (`app/templates.py`), typed persona/model
  layer (`app/personas.py`), accounts + entitlements (`app/accounts.py`),
  fidelity verification (`app/fidelity.py`).
- **Storage**: server-side SQLite (WAL) for accounts/sessions/usage ledger.
  Documents and drafts remain browser-local in this phase.

## Universal persona + template engine

- Typed, validated models: `PersonaProfile`, `TemplateSpec` (stable id, version,
  sections, field ordering, instructions), `WorkspaceContext` (active profile,
  selected template, source material, explicit locks), `StructureResponse`
  (title, ordered sections, `needs_input`, `warnings`, `unplaced`, provenance).
- 7 shipped templates: doctor (clinical note, legacy-compatible), lawyer,
  founder, teacher, architect, consultant, generic — plus a validated
  custom-template creation path (`register_template`) for any role.
- One shared structuring engine; specialty rules stay modular
  (clinical: missing-dose detection → needs_input; legal: citation handling).
- Legacy compatibility: old document IDs (`doctor_clinical_note`,
  `lawyer_case_note`, …) and saved notes keep working; drafts are normalized
  on restore (`normalizeDocument`).

## Onboarding

Six short steps, skippable-but-resumable (interrupted draft is restored with
a resume hint), "create my own" profession, industry/specialty, documentation
use, output style with a live template preview, language. Persona persists
locally; Preferences reopens it prefilled for editing. First entry shows the
wizard; it never nags after completion or explicit skip.

## Accounts & entitlements (Phase 4 core)

- Email + password accounts (PBKDF2-HMAC-SHA256, 200k iterations, per-user salt;
  plaintext never stored). Sessions: opaque 32-byte tokens in HttpOnly,
  SameSite=Lax cookies (30-day TTL). `ADA_COOKIE_SECURE=1` for HTTPS deploys.
- Plans: **free** = 10 AI generations/month (server-enforced, `429` with
  upgrade hint), **pro** = unlimited. Guests require no account and remain
  fully usable (frontend local counter applies instead).
- Usage is charged per AI structuring request for signed-in users; free local
  structuring is not counted. Entitlement state is exposed via `GET /api/auth/me`.
- Real billing is intentionally deferred: activation is a clearly named demo
  endpoint (`POST /api/entitlements/upgrade-demo`) requiring an authenticated
  session. Wire a payment provider before shipping this to end users.

## Configuration

Backend `.env` (see `backend/.env.example`):

```
LLM_BASE_URL=     # optional OpenAI-compatible endpoint; blank = local demo structurer
LLM_API_KEY=      # server-side only, never sent to the browser
LLM_MODEL=
```

Environment variables (optional): `ADA_DB=<path to sqlite file>`,
`ADA_COOKIE_SECURE=1|0`. The API is CORS-restricted to the dev app origins.

## Run

Backend:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000   # + --reload during development
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` to the backend. Production build:
`npm run build` (static output in `dist/`).

## Tests

```bash
cd backend && .venv/bin/python -m pytest tests/ -q
# includes: structuring fidelity, universal engine, templates API shape,
# accounts/auth/entitlements, legacy compatibility
```

Frontend checks: `npx tsc -b` (type-safe build gate) and `npm run build`.
Browser-level E2E (Playwright) covers onboarding, structuring, template
switching, draft restore, and the auth/usage flows.

## Product boundary

The backend never asks the model to invent missing facts; gaps are represented
explicitly (`needs_input`), unstructured residue is surfaced (`unplaced`),
and source fidelity is validated (`warnings`). The clinician/professional
remains responsible for content. A release history follows the phase plan:
0.1 doctor/lawyer two-pane → universal persona engine + templates →
onboarding → accounts/entitlements (this branch) → billing + persistent
cloud documents (next).