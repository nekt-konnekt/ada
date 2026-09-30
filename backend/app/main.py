import json
import os
import re
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
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
        if not re.search(r"\b(bp|blood pressure)\b", lower):
            missing.append("Blood pressure, if relevant")
        if not re.search(r"\b(diagnos|assessment)\b", lower):
            missing.append("Assessment / diagnosis, if established")
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
    if not re.search(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", lower):
        missing.append("Incident date")
    if not injuries:
        missing.append("Injuries / damages, if any")
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
    base = os.getenv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai").strip()
    key = os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("LLM_API_KEY", "").strip()
    model = os.getenv("LLM_MODEL", "gemini-2.5-flash").strip()

    if not key:
        return None

    if req.profession == "doctor":
        section_rules = """
- chief_complaint: the patient's main reason for seeking care, including patient-reported symptoms or concerns.
- history: chronology and context of the complaint, including what the patient reports.
- observations: clinician observations, examination findings, measurements, and vitals. Do not place patient beliefs here.
- assessment: diagnoses or clinical impressions explicitly stated or clearly established by the user's note. Preserve attribution when appropriate. Never infer a diagnosis that is not present.
- plan: treatments, medications, tests, referrals, monitoring, or follow-up the user explicitly intends or documents.
"""
        labels = {
            "chief_complaint": "Chief Complaint",
            "history": "History of Present Illness",
            "observations": "Observations / Vitals",
            "assessment": "Assessment",
            "plan": "Plan",
        }
    else:
        section_rules = """
- parties: people or organizations involved, with their roles only when stated.
- facts: factual events and chronology stated by the user. Keep allegations attributed and do not convert allegations into established facts.
- injuries: physical injury, medical treatment, property damage, or claimed damages explicitly mentioned.
- liability: legal issues, allegations of fault, defenses, or legal conclusions only when explicitly supplied by the user. Do not invent legal conclusions.
- evidence: documents, photographs, witnesses, reports, records, or other supporting material explicitly mentioned.
- next_steps: actions the user explicitly proposes, requests, or identifies as pending.
"""
        labels = {
            "parties": "Parties",
            "facts": "Facts / Incident Summary",
            "injuries": "Injuries / Damages",
            "liability": "Liability / Issues",
            "evidence": "Supporting Information",
            "next_steps": "Next Steps",
        }

    schema = list(labels.keys())
    prompt = f"""You are Ada, a real-time professional note-to-document engine for a {req.profession}.

Your task is semantic structuring, not keyword matching and not summarization.

Read the raw notes as a whole. Identify the role of each statement before assigning it to a section.

{section_rules}

NON-NEGOTIABLE RULES:
1. Use only information present in the raw notes. Never invent facts.
2. Never turn a patient's belief into a clinician observation or diagnosis.
3. Never turn an allegation into an established legal fact.
4. Preserve uncertainty and attribution: "patient reports", "user states", "clinician observes", "alleged", or equivalent wording when the source matters.
5. Preserve the user's intended actions as intentions, not completed actions. For example, "I intend to prescribe..." is not "prescribed."
6. Do not copy the entire raw note into a generic section. Each statement should go to its most appropriate section, and a statement should not be duplicated unless necessary for clarity.
7. Do not infer missing dates, dosages, measurements, names, diagnoses, liability, or other professional conclusions.
8. Empty information stays empty.
9. needs_input should identify useful missing information only when it is relevant to completing the document. Do not invent a requirement simply because a standard template contains a field.
10. Keep the wording concise and professional while preserving the meaning of the source.
11. The user remains the final authority. Do not silently overwrite a user-edited section when its existing content conflicts with a new inference.

Return JSON only. No markdown and no commentary.

JSON shape:
{{
  "title": "Clinical Note" or "Case Note",
  "sections": [
    {{"id": "section_id", "label": "section label", "content": "structured content"}}
  ],
  "needs_input": ["specific missing information"]
}}

Return exactly these section ids in this order:
{json.dumps(schema)}

Current document:
{json.dumps(req.current_document, ensure_ascii=False)}

Raw notes:
{req.notes}
"""

    url = base.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": "You are a deterministic professional documentation engine. Return valid JSON only."},
            {"role": "user", "content": prompt},
        ],
    }

    try:
        async with httpx.AsyncClient(timeout=45) as client:
            r = await client.post(
                url,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=payload,
            )
            r.raise_for_status()
            data = r.json()
            content = data["choices"][0]["message"]["content"].strip()
            if content.startswith("```"):
                content = re.sub(r"^```(?:json)?\\s*|\\s*```$", "", content, flags=re.IGNORECASE).strip()
            parsed = json.loads(content)
            sections = parsed.get("sections", [])

            valid_ids = set(schema)
            normalized = []
            for item in sections:
                if not isinstance(item, dict) or item.get("id") not in valid_ids:
                    continue
                item["label"] = labels[item["id"]]
                item["content"] = str(item.get("content") or "").strip()
                normalized.append(item)

            by_id = {item["id"]: item for item in normalized}
            ordered = [
                by_id.get(section_id, {"id": section_id, "label": labels[section_id], "content": ""})
                for section_id in schema
            ]

            needs = parsed.get("needs_input", [])
            if not isinstance(needs, list):
                needs = []

            return StructureResponse(
                profession=req.profession,
                title=parsed.get("title") or ("Clinical Note" if req.profession == "doctor" else "Case Note"),
                sections=ordered,
                needs_input=[str(x).strip() for x in needs if str(x).strip()],
                provider=model,
            )
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:2000]
        raise HTTPException(status_code=502, detail=f"Gemini API error: {detail}") from exc
    except (httpx.RequestError, KeyError, IndexError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Gemini response error: {type(exc).__name__}: {exc}") from exc


@app.get("/api/health")
async def health():
    configured = bool(
        (os.getenv("GEMINI_API_KEY") or os.getenv("LLM_API_KEY"))
        and os.getenv("LLM_MODEL", "gemini-2.5-flash")
    )
    return {"ok": True, "version": "0.1.0", "llm_configured": configured, "model": os.getenv("LLM_MODEL", "gemini-2.5-flash")}


@app.post("/api/structure", response_model=StructureResponse)
async def structure(req: StructureRequest):
    result = await llm_structure(req)
    if result:
        return result
    return local_structure(req.profession, req.notes)
