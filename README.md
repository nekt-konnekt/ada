# Ada 0.1

Ada is a real-time professional note-to-document workspace for doctors and lawyers.

Write naturally on the left. Ada structures the professional document on the right.

## Bootstrap stack

- React + Vite + TypeScript
- Plain CSS for the first visual shell
- FastAPI backend
- Replaceable OpenAI-compatible LLM adapter
- Browser state only in 0.1
- No database, auth, billing, or OCR in this release

## Run

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Copy `.env.example` to `.env` and configure an OpenAI-compatible endpoint if you want live AI. Without one, the backend uses a deterministic local demo structurer so the UI remains usable.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal.

## Product boundary

0.1 intentionally focuses on one loop:

`free-form notes -> live structured document -> human editing`

Profession modes:
- Doctor
- Lawyer

The backend never asks the model to invent missing facts. Missing information is represented explicitly.
