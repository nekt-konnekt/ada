import json
import os
import re
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI(title="Ada 0.1 API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

Profession = Literal["doctor", "lawyer"]

class StructureRequest(BaseModel):
    profession: Profession
    notes: str = Field(max_length=30000)
    current_document: dict = Field(default_factory=dict)

class StructureResponse(BaseModel):
    profession: Profession
    title: str
    sections: list[dict]
    needs_input: list[str] = Field(default_factory=list)
    provider: str


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def sentences(text: str) -> list[str]:
    return [x.strip(" .") for x in re.split(r"(?<=[.!?])\s+|\n+", text) if x.strip()]


def local_structure(profession: Profession, notes: str) -> StructureResponse:
    n = clean(notes)
    if not n:
        if profession == "doctor":
            sections = [
                {"id": "chief_complaint", "label": "Chief Complaint", "content": ""},
                {"id": "history", "label": "History of Present Illness", "content": ""},
                {"id": "observations", "label": "Observations / Vitals", "content": ""},
                {"id": "assessment", "label": "Assessment", "content": ""},
                {"id": "plan", "label": "Plan", "content": ""},
            ]
            return StructureResponse(profession=profession, title="Clinical Note", sections=sections, provider="local-demo")
        sections = [
            {"id": "parties", "label": "Parties", "content": ""},
            {"id": "facts", "label": "Facts / Incident Summary", "content": ""},
            {"id": "injuries", "label": "Injuries / Damages", "content": ""},
            {"id": "liability", "label": "Liability / Issues", "content": ""},
            {"id": "evidence", "label": "Supporting Information", "content": ""},
            {"id": "next_steps", "label": "Next Steps", "content": ""},
        ]
        return StructureResponse(profession=profession, title="Case Note", sections=sections, provider="local-demo")

    ss = sentences(notes)
    lower = n.lower()

    if profession == "doctor":
        chief = next((s for s in ss if any(k in s.lower() for k in ["complain", "pain", "fever", "cough", "headache", "came in", "presented"])), "")
        vitals = " ".join(s for s in ss if any(k in s.lower() for k in ["bp", "blood pressure", "pulse", "temp", "temperature", "spo2", "oxygen"]))
        plan = " ".join(s for s in ss if any(k in s.lower() for k in ["gave", "given", "prescribed", "follow up", "follow-up", "review"]))
        history = " ".join(s for s in ss if s not in {chief, vitals, plan})
        missing = []
        if not re.search(r"\b(bp|blood pressure)\b", lower): missing.append("Blood pressure, if relevant")
        if not re.search(r"\b(diagnos|assessment)\b", lower): missing.append("Assessment / diagnosis, if established")
        sections = [
            {"id": "chief_complaint", "label": "Chief Complaint", "content": chief},
            {"id": "history", "label": "History of Present Illness", "content": history},
            {"id": "observations", "label": "Observations / Vitals", "content": vitals},
            {"id": "assessment", "label": "Assessment", "content": ""},
            {"id": "plan", "label": "Plan", "content": plan},
        ]
        return StructureResponse(profession=profession, title="Clinical Note", sections=sections, needs_input=missing, provider="local-demo")

    parties = " ".join(s for s in ss if any(k in s.lower() for k in ["client", "plaintiff", "defendant", "driver", "company", "insurer"]))
    facts = " ".join(s for s in ss if s not in {parties} and any(k in s.lower() for k in ["accident", "hit", "collision", "happened", "driving", "road", "vehicle", "incident"]))
    injuries = " ".join(s for s in ss if any(k in s.lower() for k in ["pain", "injury", "injured", "hospital", "x-ray", "headache", "neck", "back", "medical"]))
    evidence = " ".join(s for s in ss if any(k in s.lower() for k in ["police", "report", "photo", "witness", "record", "xray", "x-ray"]))
    remainder = " ".join(s for s in ss if s not in {parties, facts, injuries, evidence})
    missing = []
    if not re.search(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", lower): missing.append("Incident date")
    if not injuries: missing.append("Injuries / damages, if any")
    sections = [
        {"id": "parties", "label": "Parties", "content": parties},
        {"id": "facts", "label": "Facts / Incident Summary", "content": facts or remainder},
        {"id": "injuries", "label": "Injuries / Damages", "content": injuries},
        {"id": "liability", "label": "Liability / Issues", "content": ""},
        {"id": "evidence", "label": "Supporting Information", "content": evidence},
        {"id": "next_steps", "label": "Next Steps", "content": remainder if facts else ""},
    ]
    return StructureResponse(profession=profession, title="Case Note", sections=sections, needs_input=missing, provider="local-demo")


async def llm_structure(req: StructureRequest) -> StructureResponse | None:
    base = os.getenv("LLM_BASE_URL", "").strip()
    key = os.getenv("LLM_API_KEY", "").strip()
    model = os.getenv("LLM_MODEL", "").strip()
    if not (base and key and model):
        return None

    schema = {
        "doctor": ["chief_complaint", "history", "observations", "assessment", "plan"],
        "lawyer": ["parties", "facts", "injuries", "liability", "evidence", "next_steps"],
    }[req.profession]
    prompt = f"""You are Ada, a professional note structuring engine for a {req.profession}.

Convert the user's raw notes into a structured document. Preserve only facts present in the notes. Never invent facts, diagnoses, legal conclusions, dates, amounts, names, or treatment. Empty fields must remain empty.

Return JSON only with this exact shape:
{{"title": string, "sections": [{{"id": string, "label": string, "content": string}}], "needs_input": [string]}}

Section ids must be: {json.dumps(schema)}.

Current document: {json.dumps(req.current_document, ensure_ascii=False)}
Raw notes:
{req.notes}"""
    url = base.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": "You are a deterministic professional documentation engine."},
            {"role": "user", "content": prompt},
        ],
        "response_format": {"type": "json_object"},
    }
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            r = await client.post(url, headers={"Authorization": f"Bearer {key}"}, json=payload)
            r.raise_for_status()
            data = r.json()
            content = data["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            return StructureResponse(profession=req.profession, title=parsed.get("title") or ("Clinical Note" if req.profession == "doctor" else "Case Note"), sections=parsed.get("sections", []), needs_input=parsed.get("needs_input", []), provider=model)
    except Exception:
        return None


@app.get("/api/health")
async def health():
    return {"ok": True, "version": "0.1.0", "llm_configured": bool(os.getenv("LLM_BASE_URL") and os.getenv("LLM_API_KEY") and os.getenv("LLM_MODEL"))}

@app.post("/api/structure", response_model=StructureResponse)
async def structure(req: StructureRequest):
    result = await llm_structure(req)
    if result:
        return result
    return local_structure(req.profession, req.notes)
