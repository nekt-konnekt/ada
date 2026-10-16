"""Template registry for Ada's universal documentation engine.

Bundles the shipped templates. Existing doctor and lawyer workflows keep their
section ids/labels/keyphrases exactly as in 0.1 (legacy documents and tests
depend on them); new general workflows follow the same schema. Custom
user-authored templates are validated with the same models at runtime.
"""
from __future__ import annotations

from app.personas import SectionSpec, TemplateSpec

SECTION = SectionSpec.model_validate


def _doctor_clinical_note() -> TemplateSpec:
    return TemplateSpec(
        id="doctor_clinical_note",
        name="Clinical Note",
        version=2,
        profession="doctor",
        profession_label="Doctor",
        industries=["healthcare"],
        document_kind="clinical_note",
        title="Clinical Note",
        sections=[
            SECTION({"id": "chief_complaint", "label": "Chief Complaint", "keyphrases": ["complain", "presenting", "came in", "here for", "pain", "headache", "cough"]}),
            SECTION({"id": "history", "label": "History of Present Illness", "keyphrases": ["since", "worse", "better", "history", "reports", "started", "yesterday", "today", "for "]}),
            SECTION({"id": "history_social_family", "label": "Past / Social / Family History", "keyphrases": ["past medical", "family history", "social history", "smokes", "smoking", "alcohol"]}),
            SECTION({"id": "allergies", "label": "Allergies", "keyphrases": ["allerg", "no known"]}),
            SECTION({"id": "observations", "label": "Observations / Vitals", "keyphrases": ["bp", "blood pressure", "pulse", "hr ", "temperature", "temp ", "weight", "height", "vital", "36.", "98"]}),
            SECTION({"id": "examination", "label": "Examination Findings", "keyphrases": ["exam", "examination", "tender", "swelling", "lungs", "heart sounds", "murmur"]}),
            SECTION({"id": "investigations", "label": "Investigations", "keyphrases": ["x-ray", "xray", "mri", "ct ", "lab", "test result", "investigation", "ecg", "troponin"]}),
            SECTION({"id": "assessment", "label": "Assessment", "keyphrases": ["assessment", "diagnos", "impression", "?", "vs ", "possible", "likely"]}),
            SECTION({"id": "plan", "label": "Plan", "keyphrases": ["plan", "prescrib", "refer", "start", "continue", "give", "advise", "aspirin", "mg"]}),
            SECTION({"id": "follow_up", "label": "Follow-up", "keyphrases": ["follow-up", "follow up", "return", "revisit", "review"]}),
        ],
        needs_input_on=["plan"],
        validator="clinical",
        instructions=(
            "Structure into a clinical note. Never invent names, doses, dates, or findings. "
            "Preserve negations ('denies', 'no'), uncertainty markers ('?', 'possible', 'likely'), "
            "attribution ('father had MI'), units and measurements exactly as written. "
            "If a plan mentions a drug without a dose, raise needs_input asking for the dose. "
            "Content that cannot be confidently placed stays out and is reported as unplaced."
        ),
    )


def _lawyer_case_note() -> TemplateSpec:
    return TemplateSpec(
        id="lawyer_case_note",
        name="Case Note",
        version=2,
        profession="lawyer",
        profession_label="Lawyer",
        industries=["legal"],
        document_kind="case_note",
        title="Case Note",
        sections=[
            SECTION({"id": "parties", "label": "Parties", "keyphrases": ["plaintiff", "defendant", "client", "company", "insurer", "driver"]}),
            SECTION({"id": "facts", "label": "Facts / Incident Summary", "keyphrases": ["incident", "accident", "happened", "collision", "drove", "driving", "occurred"]}),
            SECTION({"id": "injuries", "label": "Injuries / Damages", "keyphrases": ["injury", "injured", "damage", "pain", "hospital", "medical", "loss"]}),
            SECTION({"id": "liability", "label": "Liability / Issues", "keyphrases": ["liable", "liability", "fault", "negligence", "issue", "claim"]}),
            SECTION({"id": "authorities", "label": "Authorities", "keyphrases": ["act ", "section ", "case ", "v.", "regulation", "statute"]}),
            SECTION({"id": "evidence", "label": "Supporting Information", "keyphrases": ["witness", "photo", "police", "report", "document", "record", "evidence"]}),
            SECTION({"id": "next_steps", "label": "Next Steps", "keyphrases": ["next", "file", "send", "review", "draft", "follow up", "meeting"]}),
        ],
        needs_input_on=["next_steps"],
        validator="legal",
        instructions=(
            "Structure into a case note. Never invent names, dates, citations, or legal conclusions. "
            "Preserve chronology and attribution. Content that cannot be confidently placed is reported."
        ),
    )


def _founder_meeting_notes() -> TemplateSpec:
    return TemplateSpec(
        id="founder_meeting_notes",
        name="Meeting Notes — Founder",
        version=1,
        profession="founder",
        profession_label="Founder",
        industries=["startup", "business"],
        document_kind="meeting_notes",
        title="Meeting Notes",
        sections=[
            SECTION({"id": "attendees", "label": "Attendees", "keyphrases": ["attend", "present", "joined", "met with", "meeting with"]}),
            SECTION({"id": "decisions", "label": "Decisions", "keyphrases": ["decide", "decision", "agreed", "we will", "chose", "approved"]}),
            SECTION({"id": "owners", "label": "Owners", "keyphrases": ["owner", "responsible", "assign", "will do", "owns"]}),
            SECTION({"id": "deadlines", "label": "Deadlines", "keyphrases": ["deadline", "by ", "friday", "monday", "next week", "due", "before"]}),
            SECTION({"id": "investor_updates", "label": "Investor / Stakeholder Updates", "keyphrases": ["investor", "raise", "round", "valuation", "term sheet", "update"]}),
            SECTION({"id": "open_questions", "label": "Open Questions", "keyphrases": ["?", "question", "unclear", "confirm", "unsure", "need to"]}),
            SECTION({"id": "next_steps", "label": "Next Steps", "keyphrases": ["next", "follow up", "send", "draft", "action", "todo", "task"]}),
        ],
        needs_input_on=["owners", "deadlines"],
        instructions=(
            "Structure into meeting notes: keep decisions attached with owner and deadline as stated. "
            "Never invent owners, dates, amounts, or company names. Preserve who-said-what attribution."
        ),
    )


def _teacher_lesson_plan() -> TemplateSpec:
    return TemplateSpec(
        id="teacher_lesson_plan",
        name="Lesson Plan",
        version=1,
        profession="teacher",
        profession_label="Teacher",
        industries=["education"],
        document_kind="lesson_plan",
        title="Lesson Plan",
        sections=[
            SECTION({"id": "class_and_subject", "label": "Class / Subject", "keyphrases": ["class", "subject", "grade", "primary", "jss", "sss", "year "]}),
            SECTION({"id": "learning_objectives", "label": "Learning Objectives", "keyphrases": ["objective", "students will", "pupils will", "learn", "able to", "understand"]}),
            SECTION({"id": "materials", "label": "Materials", "keyphrases": ["material", "chart", "textbook", "board", "bring", "handout", "slide"]}),
            SECTION({"id": "sequence", "label": "Lesson Sequence", "keyphrases": ["first", "then", "next", "after that", "step", "minute", "starter", "main", "plenary"]}),
            SECTION({"id": "assessment", "label": "Assessment / Checks", "keyphrases": ["assess", "quiz", "question", "check", "exercise", "homework", "mark"]}),
            SECTION({"id": "differentiation", "label": "Differentiation / Support", "keyphrases": ["support", "struggle", "slow", "fast finisher", "aid", "group"]}),
            SECTION({"id": "homework_and_follow_up", "label": "Homework / Follow-up", "keyphrases": ["homework", "assignment", "revise", "next lesson", "follow up", "reading"]}),
        ],
        needs_input_on=["learning_objectives"],
        instructions=(
            "Structure into a lesson plan. Never invent class names, times, or curriculum references. "
            "Preserve the teacher's sequence order and subject-specific wording."
        ),
    )


def _architect_site_report() -> TemplateSpec:
    return TemplateSpec(
        id="architect_site_report",
        name="Site Observation Report",
        version=1,
        profession="architect",
        profession_label="Architect",
        industries=["construction", "property"],
        document_kind="inspection_report",
        title="Site Observation Report",
        sections=[
            SECTION({"id": "project_and_site", "label": "Project / Site", "keyphrases": ["site", "project", "plot", "block", "floor ", "phase"]}),
            SECTION({"id": "observations", "label": "Observations", "keyphrases": ["observed", "seen", "wall", "beam", "column", "slab", "level", "foundation"]}),
            SECTION({"id": "defects", "label": "Defects / Non-conformance", "keyphrases": ["defect", "defective", "crack", "offset", "not to spec", "deviation", "hollow"]}),
            SECTION({"id": "measurements", "label": "Measurements", "keyphrases": ["mm", "cm", "meter", "level", "set out", "measured", "%"]}),
            SECTION({"id": "actions", "label": "Action Items", "keyphrases": ["action", "rectify", "correct", "instruct", "contractor", "redo", "fix"]}),
            SECTION({"id": "next_visit", "label": "Next Visit / Follow-up", "keyphrases": ["next visit", "revisit", "return", "follow up", "check again", "recheck"]}),
            SECTION({"id": "safety_notes", "label": "Safety Notes", "keyphrases": ["safety", "hazard", "ppe", "guard", "scaffold", "risk", "dangerous"]}),
        ],
        needs_input_on=["actions"],
        instructions=(
            "Structure into a site observation report. Never invent measurements, dates, or contractor names. "
            "Preserve readings, tolerances and deviations exactly; missing values become needs_input."
        ),
    )


def _consultant_meeting_summary() -> TemplateSpec:
    return TemplateSpec(
        id="consultant_meeting_summary",
        name="Engagement Summary",
        version=1,
        profession="consultant",
        profession_label="Consultant",
        industries=["consulting", "business"],
        document_kind="meeting_summary",
        title="Engagement Summary",
        sections=[
            SECTION({"id": "client_and_context", "label": "Client / Context", "keyphrases": ["client", "stakeholder", "engagement", "project", "department"]}),
            SECTION({"id": "findings", "label": "Findings", "keyphrases": ["found", "finding", "data shows", "observed", "reported", "indicates"]}),
            SECTION({"id": "recommendations", "label": "Recommendations", "keyphrases": ["recommend", "should", "suggest", "propose", "option", "way forward"]}),
            SECTION({"id": "risks", "label": "Risks / Watch-outs", "keyphrases": ["risk", "concern", "bottleneck", "delay", "budget", "resistance"]}),
            SECTION({"id": "next_steps", "label": "Next Steps", "keyphrases": ["next", "action", "follow up", "send", "schedule", "week"]}),
        ],
        needs_input_on=["recommendations"],
        instructions=(
            "Structure into an engagement summary. Never invent figures, client names, or commitments. "
            "Preserve qualifiers ('approximately', estimates) exactly as stated."
        ),
    )


def _generic_freeform() -> TemplateSpec:
    return TemplateSpec(
        id="generic_freeform",
        name="General Document",
        version=1,
        profession="generic",
        profession_label="General",
        document_kind="note",
        title="Professional Document",
        sections=[
            SECTION({"id": "summary", "label": "Summary"}),
            SECTION({"id": "key_points", "label": "Key Points"}),
            SECTION({"id": "details", "label": "Details"}),
            SECTION({"id": "decisions", "label": "Decisions", "keyphrases": ["decide", "agreed", "approved", "chose"]}),
            SECTION({"id": "actions", "label": "Actions / Next Steps", "keyphrases": ["next", "action", "todo", "follow up", "deadline", "due"]}),
            SECTION({"id": "open_questions", "label": "Open Questions", "keyphrases": ["?", "unclear", "confirm", "question"]}),
        ],
        needs_input_on=["actions"],
        instructions=(
            "Structure into a clean professional document. Never invent facts, names, dates, or numbers. "
            "Preserve negations, uncertainty and attribution; keep unplaceable content out and report it."
        ),
    )


REGISTRY: dict[str, TemplateSpec] = {
    spec.id: spec
    for spec in [
        _doctor_clinical_note(),
        _lawyer_case_note(),
        _founder_meeting_notes(),
        _teacher_lesson_plan(),
        _architect_site_report(),
        _consultant_meeting_summary(),
        _generic_freeform(),
    ]
}

LEGACY_PROFESSION_TO_TEMPLATE = {
    "doctor": "doctor_clinical_note",
    "lawyer": "lawyer_case_note",
}

DEFAULT_TEMPLATE_BY_PROFESSION: dict[str, str] = {
    "doctor": "doctor_clinical_note",
    "lawyer": "lawyer_case_note",
    "founder": "founder_meeting_notes",
    "teacher": "teacher_lesson_plan",
    "architect": "architect_site_report",
    "consultant": "consultant_meeting_summary",
}


def get_template(template_id: str) -> TemplateSpec:
    return REGISTRY[template_id]


def template_for_profile_or_profession(profession: str | None, template_id: str | None) -> TemplateSpec:
    """Resolve the active template: explicit template_id wins; legacy profession
    tokens are accepted in either argument; then profession default; then generic.
    Never raises for unknown values."""
    for token in (template_id, profession):
        token = (token or "").lower()
        if not token:
            continue
        if token in REGISTRY:
            return REGISTRY[token]
        legacy = LEGACY_PROFESSION_TO_TEMPLATE.get(token)
        if legacy:
            return REGISTRY[legacy]
        default = DEFAULT_TEMPLATE_BY_PROFESSION.get(token)
        if default:
            return REGISTRY[default]
    return REGISTRY["generic_freeform"]


def list_templates() -> list[dict]:
    return [
        {
            "id": spec.id,
            "name": spec.name,
            "version": spec.version,
            "profession": spec.profession,
            "profession_label": spec.profession_label,
            "industries": spec.industries,
            "document_kind": spec.document_kind,
            "custom": spec.custom,
            "sections": [{"id": s.id, "label": s.label, "field_kind": s.field_kind} for s in spec.sections],
        }
        for spec in REGISTRY.values()
    ]


def register_custom_template(payload: dict) -> TemplateSpec:
    """Validate a user-authored template and register it (runtime registry)."""
    payload = dict(payload)
    payload["custom"] = True
    raw_id = str(payload.get("id") or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not raw_id:
        # derive a stable id from the template name (user-friendly default)
        name = str(payload.get("name") or "").strip()
        raw_id = "".join(ch for ch in name.lower().replace("-", "_").replace(" ", "_") if ch.isalnum() or ch == "_").strip("_")
    if not raw_id or not raw_id.replace("_", "").isalnum():
        raise ValueError("custom template requires an id or name (alphanumeric)")
    payload["id"] = "custom_" + raw_id
    spec = TemplateSpec.model_validate(payload)
    REGISTRY[spec.id] = spec
    return spec