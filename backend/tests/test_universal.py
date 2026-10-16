"""Universal-engine tests: new professions, custom templates, locked sections,
legacy compatibility for doctor/lawyer workflows."""
from fastapi.testclient import TestClient

from app.main import app, local_structure
from app.templates import register_custom_template, template_for_profile_or_profession

client = TestClient(app)

FOUNDER_NOTE = (
    "Met with Adebayo at Lekki office. Decided to pause the Lekki phase. "
    "Folake owns the permits draft, due Friday. Unclear if the bank will "
    "release funds. Next steps: send the revised budget to investors."
)


def test_new_profession_structures_with_template_sections():
    response = local_structure("founder", FOUNDER_NOTE)
    ids = [s["id"] for s in response.sections]
    assert "decisions" in ids and "owners" in ids and "next_steps" in ids
    decisions = next(s["content"] for s in response.sections if s["id"] == "decisions")
    assert "pause the Lekki phase" in decisions
    assert "Adebayo" in next(s["content"] for s in response.sections if s["id"] == "attendees")


def test_architect_preserves_measurements():
    note = "Floor 3 slab: crack 2mm observed at column C4. Action: contractor to rectify before plaster. Next visit Tuesday."
    response = local_structure("architect", note)
    # mixed sentence (site + defect cue) lands in its strongest bucket; the
    # invariant that matters is the measurement is preserved verbatim somewhere.
    assert any("2mm" in s["content"] for s in response.sections)
    actions = next(s["content"] for s in response.sections if s["id"] == "actions")
    assert "rectify" in actions


def test_custom_template_creation_and_structure():
    spec = register_custom_template({
        "name": "Journalist Interview Sheet",
        "profession": "journalist",
        "document_kind": "interview",
        "sections": [
            {"id": "interviewee", "label": "Interviewee", "keyphrases": ["interview", "speaks", "told", "per"]},
            {"id": "quotes", "label": "Notable Quotes", "keyphrases": ["said", "said that", "asked"]},
            {"id": "followups", "label": "Follow-ups", "keyphrases": ["follow up", "pending", "answer"]},
        ],
    })
    assert spec.id.startswith("custom_")
    resolved = template_for_profile_or_profession("journalist", spec.id)
    assert resolved.id == spec.id
    response = local_structure("journalist", "Adeola speaks on water access. said the borehole failed twice. follow up: get ministry answer.",
                               template_id=spec.id)
    quotes = next(s["content"] for s in response.sections if s["id"] == "quotes")
    assert "borehole failed twice" in quotes


def test_locked_sections_survive_local_structure():
    base = local_structure("doctor", open("tests/fixtures/clinical_note.txt").read())
    doc = {"sections": [], "title": base.title}
    locked_doc = {"sections": [{"id": "assessment", "content": "USER EDITED ASSESSMENT"}], "title": "Clinical Note"}
    response = local_structure("doctor", open("tests/fixtures/clinical_note.txt").read(),
                               current_document=locked_doc, locked_sections=["assessment"])
    assessment = next(s["content"] for s in response.sections if s["id"] == "assessment")
    assert assessment == "USER EDITED ASSESSMENT"


def test_legacy_doctor_via_api_endpoint():
    res = client.post("/api/structure", json={
        "profession": "doctor",
        "notes": "48yo F, cough 3 days, fever 38.2. Exam: lungs clear. Plan: paracetamol. Follow-up in 5 days.",
    })
    assert res.status_code == 200
    body = res.json()
    labels = {s["label"] for s in body["sections"]}
    assert "Plan" in labels and "Follow-up" in labels
    assert body["provider_name"] == "local demo"


def test_templates_endpoint_lists_registry():
    res = client.get("/api/templates")
    assert res.status_code == 200
    ids = [t["id"] for t in res.json()["templates"]]
    assert "doctor_clinical_note" in ids and "generic_freeform" in ids
    for template in res.json()["templates"]:
        assert {"id", "name", "version", "sections"} <= set(template.keys())


def test_new_profession_via_api_endpoint():
    res = client.post("/api/structure", json={
        "profession": "founder",
        "template_id": "founder_meeting_notes",
        "notes": FOUNDER_NOTE,
    })
    assert res.status_code == 200
    ids = {s["id"] for s in res.json()["sections"]}
    assert "decisions" in ids and "deadlines" in ids


def test_unknown_profession_falls_back_to_generic():
    res = client.post("/api/structure", json={
        "profession": "opera singer",
        "notes": "Rehearsal: soprano arrives 4pm. Decided to cut the second aria. Follow up on score delivery.",
    })
    assert res.status_code == 200
    ids = {s["id"] for s in res.json()["sections"]}
    assert "decisions" in ids  # generic_freeform still buckets decisions