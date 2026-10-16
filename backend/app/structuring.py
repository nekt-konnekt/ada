"""Shared, template-driven structuring engine.

Backward compatible: the doctor and lawyer branches reuse the verified 0.1
bucket logic and fidelity checks verbatim. New templates fall through to the
generic keyphrase bucketing driven by their TemplateSpec. Specialty rules
(dose detection, injection discipline) stay modular per template validator.
"""
from __future__ import annotations

import re

from app.fidelity import _is_note_instruction, completeness_check, sentences, validate_fidelity
from app.personas import ProvenanceSpan, StructureResponse, WorkspaceContext
from app.templates import TemplateSpec, template_for_profile_or_profession

# ---- generic template-driven bucketing ----

def _bucket_by_keyphrases(ss: list[str], template: TemplateSpec) -> dict[str, str]:
    buckets: dict[str, list[str]] = {sid: [] for sid in template.section_ids()}
    consumed: set[str] = set()
    sections = template.sections
    for sentence in ss:
        if sentence in consumed:
            continue
        lowered = sentence.lower()
        hits = []
        for index, section in enumerate(sections):
            score = 0
            for kp in section.keyphrases:
                if (re.search(re.escape(kp), lowered) if (" " in kp or kp in ("?", "%", "v.")) else re.search(kp, lowered, re.I)):
                    score += 1
            if score:
                hits.append((-score, index, section.id))
        if hits:
            hits.sort()
            buckets[hits[0][2]].append(sentence)
            consumed.add(sentence)
    return {sid: " ".join(parts) for sid, parts in buckets.items()}

def _generic_structure(template: TemplateSpec, notes: str, ss: list[str]) -> StructureResponse:
    buckets = _bucket_by_keyphrases(ss, template)
    used_texts = " ".join(v for v in buckets.values() if v).lower()
    lead_id = template.sections[0].id
    summary = " ".join(s for s in ss[:2] if s.lower() not in used_texts) if buckets.get(lead_id, "") == "" else buckets.get(lead_id, "")
    sections = [
        {"id": s.id, "label": s.label, "content": buckets.get(s.id, "")}
        for s in template.sections
    ]
    if summary:
        for sec in sections:
            if sec["id"] == lead_id and not sec["content"]:
                sec["content"] = summary
    return StructureResponse(
        profession=template.profession or "generic",
        template_id=template.id,
        title=template.title or "Professional Document",
        sections=sections,
        provider="local-demo",
    )

# ---- specialty: clinical (verbatim behavior from 0.1) ----

def _clinical_structure(template: TemplateSpec, notes: str, ss: list[str]) -> StructureResponse:
    lower = " ".join(ss).lower()

    def join_matching(patterns: list[str]) -> str:
        return " ".join(s for s in ss if any(re.search(pattern, s, re.I) for pattern in patterns))

    chief_source = next((s for s in ss if re.search(r"\b(chest pain|pain|fever|cough|headache|complain|presented|came in)\b", s, re.I)), "")
    _m = re.search(r"\b(chest pain|pain|fever|cough|headache)\b", chief_source, re.I)
    chief = _m.group(0) if _m else chief_source
    history_social_family = join_matching([r"\bsmoker\b", r"\bfather\b", r"\bfamily\b", r"\bmedical history\b", r"\bsocial history\b"])
    allergies = join_matching([r"\ballerg"])
    observations = join_matching([r"\bBP\b", r"\bHR\b", r"\btemp\b"])
    examination = join_matching([r"\blungs\b", r"\bheart sounds\b", r"\bmurmur\b"])
    investigations = join_matching([r"\bECG\s+done\b", r"\bECG\s+result\b", r"\bECG\s+show"])
    assessment = next((s for s in ss if re.search(r"\?\s*angina|\bassessment\b", s, re.I)), "")
    plan = join_matching([r"\bplan:", r"\baspirin\b", r"\btroponin\b", r"\brepeat ECG\b", r"\brefer\b", r"\badvise\b"])
    follow_up = join_matching([r"\breview\b", r"\bfollow[- ]?up\b"])
    history_excluded = [
        r"\bsmoker\b", r"\bfather\b", r"\ballerg", r"\bBP\b", r"\bHR\b", r"\btemp\b",
        r"\blungs\b", r"\bheart sounds\b", r"\bmurmur\b", r"\bECG\b", r"\?\s*angina",
        r"\bplan:", r"\baspirin\b", r"\btroponin\b", r"\brepeat ECG\b", r"\brefer\b", r"\badvise\b",
        r"\breview\b", r"\bfollow[- ]?up\b"
    ]
    history = " ".join(s for s in ss if (s == chief_source or not any(re.search(pattern, s, re.I) for pattern in history_excluded)) and s != chief)
    by_id = {
        "chief_complaint": chief,
        "history": history,
        "history_social_family": history_social_family,
        "allergies": allergies,
        "observations": observations,
        "examination": examination,
        "investigations": investigations,
        "assessment": assessment,
        "plan": plan,
        "follow_up": follow_up,
    }
    sections = [{"id": s.id, "label": s.label, "content": by_id.get(s.id, "")} for s in template.sections]
    dose_needs = re.search(r"\b(aspirin|ibuprofen|paracetamol|amoxicillin)\b", lower) and not re.search(
        r"\b(aspirin|ibuprofen|paracetamol|amoxicillin)\s+\d", lower)
    return StructureResponse(
        profession="doctor",
        template_id=template.id,
        title="Clinical Note",
        sections=sections,
        needs_input=([{"id": "plan", "question": "What dose was intended for any medication without a stated dose?", "section_id": "plan"}] if dose_needs else []),
        provider="local-demo",
    )

# ---- specialty: legal (verbatim behavior from 0.1) ----

def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()

def _legal_structure(template: TemplateSpec, notes: str, ss: list[str]) -> StructureResponse:
    parties = " ".join(s for s in ss if any(k in s.lower() for k in ["client", "plaintiff", "defendant", "driver", "company", "insurer"]))
    facts = " ".join(s for s in ss if s != parties and any(k in s.lower() for k in ["accident", "hit", "collision", "happened", "driving", "road", "vehicle", "incident"]))
    injuries = " ".join(s for s in ss if any(k in s.lower() for k in ["pain", "injury", "injured", "hospital", "x-ray", "headache", "neck", "back", "medical"]))
    evidence = " ".join(s for s in ss if any(k in s.lower() for k in ["police", "report", "photo", "witness", "record", "xray", "x-ray"]))
    authorities = "; ".join(_clean(match) for match in re.findall(r"(?i)\b[A-Z][A-Za-z'’.-]+(?:\s+v\.?\s+[A-Z][A-Za-z'’.-]+)+\s*\([^)]*\d{4}[^)]*\)", notes))
    remainder = " ".join(s for s in ss if s != parties and s != facts and s != injuries and s != evidence)
    by_id = {
        "parties": parties,
        "facts": facts or remainder,
        "injuries": injuries,
        "liability": "",
        "authorities": authorities,
        "evidence": evidence,
        "next_steps": remainder if facts else "",
    }
    sections = [{"id": s.id, "label": s.label, "content": by_id.get(s.id, "")} for s in template.sections]
    return StructureResponse(
        profession="lawyer",
        template_id=template.id,
        title="Case Note",
        sections=sections,
        needs_input=[],
        provider="local-demo",
    )

VALIDATORS = {
    "clinical": _clinical_structure,
    "legal": _legal_structure,
}

# ---- entry point ----

def structure_from_context(context: WorkspaceContext) -> StructureResponse:
    template = template_for_profile_or_profession(
        (context.profile.profession if context.profile else None),
        context.template_id,
    )
    notes = context.notes
    locked_ids = set(context.locked_sections or [])
    if not notes.strip():
        response = StructureResponse(
            profession=template.profession or "generic",
            template_id=template.id,
            template_version=template.version,
            title=template.title or "Professional Document",
            sections=[{"id": s.id, "label": s.label, "content": ""} for s in template.sections],
            provider="local-demo",
        )
        return _merge_locks(response, context)

    ss = [sentence for sentence in sentences(notes) if not _is_note_instruction(sentence)]
    handler = VALIDATORS.get(template.validator or "", _generic_structure)
    response = handler(template, notes, ss)
    response.template_id = template.id
    response.template_version = template.version
    if not response.profession:
        response.profession = template.profession or "generic"
    response.warnings = validate_fidelity(notes, context.current_document or {}, response)
    response.unplaced = completeness_check(notes, response)
    response.provenance = _provenance(notes, response)
    return _merge_locks(response, context)

def _merge_locks(response: StructureResponse, context: WorkspaceContext) -> StructureResponse:
    """User-edited + locked sections survive structuring unchanged."""
    doc = context.current_document or {}
    locked_ids = set(context.locked_sections or [])
    if not locked_ids or not doc.get("sections"):
        return response
    locked_map = {s.get("id"): s.get("content", "") for s in doc["sections"] if s.get("id") in locked_ids}
    for section in response.sections:
        if section["id"] in locked_map:
            section["content"] = locked_map[section["id"]]
    return response

def _provenance(notes: str, response: StructureResponse) -> list[ProvenanceSpan]:
    """Lightweight provenance: map each placed sentence back to its source span."""
    spans: list[ProvenanceSpan] = []
    cursor = 0
    positions: list[tuple[str, int, int]] = []
    for match in re.finditer(r"(?s).+?(?:(?<=[.!?])\s+|\n+|$)", notes):
        chunk = match.group(0)
        text = chunk.strip(" .")
        if text:
            positions.append((text, match.start(), match.end() - 1))
    output_cells = [s.get("content", "") for s in response.sections]
    for span in positions:
        text, start, end = span
        for content in output_cells:
            if text and len(text) > 12 and text[:60] in content:
                spans.append(ProvenanceSpan(section_id="", source_start=start, source_end=end, quote=text[:120]))
                break
    # attribute section ids
    for section in response.sections:
        for span in spans:
            if span.quote[:60] and span.quote[:60].lower() in section["content"].lower():
                span.section_id = section["id"]
    return [s for s in spans if s.section_id]