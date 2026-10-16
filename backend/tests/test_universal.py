"""Universal-engine tests: new professions, custom templates, locked sections,
legacy compatibility for doctor/lawyer workflows."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import StructureRequest, app, llm_structure, local_structure
import app.templates as templates
from app.templates import list_templates, register_custom_template, template_for_profile_or_profession

client = TestClient(app)

FOUNDER_NOTE = (
    "Met with Adebayo at Lekki office. Decided to pause the Lekki phase. "
    "Folake owns the permits draft, due Friday. Unclear if the bank will "
    "release funds. Next steps: send the revised budget to investors."
)


@pytest.fixture(autouse=True)
def no_live_llm(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)


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
    owner = "journalist-owner"
    spec = register_custom_template({
        "name": "Journalist Interview Sheet",
        "profession": "journalist",
        "document_kind": "interview",
        "sections": [
            {"id": "interviewee", "label": "Interviewee", "keyphrases": ["interview", "speaks", "told", "per"]},
            {"id": "quotes", "label": "Notable Quotes", "keyphrases": ["said", "said that", "asked"]},
            {"id": "followups", "label": "Follow-ups", "keyphrases": ["follow up", "pending", "answer"]},
        ],
    }, owner_id=owner)
    assert spec.id.startswith("custom_")
    resolved = template_for_profile_or_profession("journalist", spec.id, owner_id=owner)
    assert resolved.id == spec.id
    response = local_structure("journalist", "Adeola speaks on water access. said the borehole failed twice. follow up: get ministry answer.",
                               template_id=spec.id, template_owner_id=owner)
    quotes = next(s["content"] for s in response.sections if s["id"] == "quotes")
    assert "borehole failed twice" in quotes


def test_custom_templates_are_owner_scoped_and_bounded(monkeypatch):
    monkeypatch.setattr(templates, "CUSTOM_REGISTRIES", {})
    payload = {
        "id": "brief",
        "name": "Brief",
        "profession": "analyst",
        "sections": [{"id": "summary", "label": "Summary"}],
    }
    register_custom_template(payload, owner_id="owner-a")
    assert "custom_brief" in {item["id"] for item in list_templates(owner_id="owner-a")}
    assert "custom_brief" not in {item["id"] for item in list_templates(owner_id="owner-b")}
    with pytest.raises(ValueError, match="already exists"):
        register_custom_template(payload, owner_id="owner-a")
    monkeypatch.setattr(templates, "MAX_CUSTOM_TEMPLATES_PER_OWNER", 1)
    with pytest.raises(ValueError, match="limit"):
        register_custom_template({**payload, "id": "second"}, owner_id="owner-a")


def test_llm_uses_selected_template_schema_and_metadata(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200
        request = httpx.Request("POST", "https://example.test")
        text = ""

        def raise_for_status(self):
            return None

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": json.dumps({
                "title": "Meeting Notes",
                "sections": [
                    {"id": "attendees", "content": "Adebayo"},
                    {"id": "decisions", "content": "Pause Lekki"},
                ],
                "needs_input": [],
            })}]}}]}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, **kwargs):
            captured["prompt"] = kwargs["json"]["contents"][0]["parts"][0]["text"]
            return FakeResponse()

    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setattr("app.main.httpx.AsyncClient", FakeClient)
    template = template_for_profile_or_profession("founder", "founder_meeting_notes")
    response = asyncio.run(llm_structure(StructureRequest(
        profession="founder", template_id=template.id, notes=FOUNDER_NOTE
    ), template))

    assert response.template_id == "founder_meeting_notes"
    assert response.template_version == template.version
    assert [section["id"] for section in response.sections] == template.section_ids()
    assert template.instructions in captured["prompt"]
    assert "parties" not in captured["prompt"]


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