"""Universal persona and template models for Ada.

Typed, validated models that replace the hard-coded doctor/lawyer model with a
backward-compatible, extensible persona and template architecture.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

FieldKind = Literal["text", "long_text", "list", "number", "date", "code"]


class SectionSpec(BaseModel):
    """One ordered section of a document template."""

    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    description: str = ""
    field_kind: FieldKind = "long_text"
    keyphrases: list[str] = Field(default_factory=list, description="Bucketing hints; empty = fill by LLM only.")
    required: bool = False
    instructions: str = Field(default="")
    multiline: bool = True

    @field_validator("id")
    @classmethod
    def id_is_slug(cls, value: str) -> str:
        cleaned = value.strip().lower().replace("-", "_")
        if not cleaned or not cleaned.replace("_", "").isalnum():
            raise ValueError("section id must be alphanumeric/underscore")
        return cleaned


class TemplateSpec(BaseModel):
    """A reusable document template: stable identity + version + section order."""

    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=160)
    version: int = Field(default=1, ge=1)
    profession: Optional[str] = Field(default=None, description="Stable profession token, e.g. doctor, lawyer, founder.")
    profession_label: str = Field(default="")
    roles: list[str] = Field(default_factory=list, description="Additional role tokens this template serves.")
    industries: list[str] = Field(default_factory=list)
    document_kind: str = Field(default="note", description="clinical_note, referral_letter, meeting_notes, ...")
    title: str = Field(default="", description="Default document title.")
    sections: list[SectionSpec] = Field(min_length=1)
    needs_input_on: list[str] = Field(default_factory=list, description="Section ids that must prompt when key details are missing.")
    validator: Optional[str] = Field(default=None, description="Optional named validator hook for specialty safety rules.")
    instructions: str = Field(default="", description="Global structuring instructions for LLM providers.")
    custom: bool = Field(default=False, description="True for user-authored templates.")

    @field_validator("id")
    @classmethod
    def id_is_slug(cls, value: str) -> str:
        cleaned = value.strip().lower().replace("-", "_").replace(" ", "_")
        if not cleaned or not cleaned.replace("_", "").isalnum():
            raise ValueError("template id must be alphanumeric/underscore")
        return cleaned

    def section_ids(self) -> list[str]:
        return [section.id for section in self.sections]


class PersonaProfile(BaseModel):
    """The user's professional identity, persisted and switchable."""

    id: Optional[str] = None
    user_id: Optional[str] = None
    label: str = Field(default="Primary", max_length=120)
    profession: str = Field(min_length=1, max_length=80, description="Stable token; free text allowed for custom roles.")
    profession_label: str = Field(default="", max_length=120)
    industry: str = Field(default="", max_length=120)
    specialty: str = Field(default="", max_length=160)
    job_title: str = Field(default="", max_length=160)
    organization: str = Field(default="", max_length=200)
    use_cases: list[str] = Field(default_factory=list)
    default_template_id: Optional[str] = None
    locale: str = Field(default="", max_length=40)
    language: str = Field(default="en", max_length=40)
    formatting_prefix: Literal["markdown", "plain"] = "markdown"
    notes_style: Literal["concise", "detailed"] = "concise"

    @field_validator("profession")
    @classmethod
    def profession_is_slug(cls, value: str) -> str:
        cleaned = value.strip().lower().replace(" ", "_").replace("-", "_")
        if not cleaned or not cleaned.replace("_", "").isalnum():
            raise ValueError("profession must be a single slug-like token")
        return cleaned[:80]


class WorkspaceContext(BaseModel):
    """Everything the structuring engine needs for one pass."""

    profile: Optional[PersonaProfile] = None
    template_id: str
    notes: str = ""
    current_document: Optional[dict[str, Any]] = None
    locked_sections: list[str] = Field(default_factory=list)


class ProvenanceSpan(BaseModel):
    section_id: str
    source_start: int
    source_end: int
    quote: str = ""


class StructureResponse(BaseModel):
    """Validated structuring output shared by every provider."""

    profession: str = Field(default="generic")
    template_id: str = Field(default="generic_freeform")
    template_version: int = Field(default=1)
    title: str = "Professional Document"
    sections: list[dict[str, str]] = Field(default_factory=list)
    needs_input: list[dict[str, str]] = Field(default_factory=list)
    warnings: list[dict[str, Any]] = Field(default_factory=list)
    unplaced: list[str] = Field(default_factory=list)
    provider: str = "ready"
    provider_name: str = "local demo"
    provenance: list[ProvenanceSpan] = Field(default_factory=list)

    def to_public(self) -> dict[str, Any]:
        """Dict for the wire. Additive only: preserves the 0.1 document contract
        (profession, title, sections, needs_input, warnings, unplaced, provider)."""
        return self.model_dump(exclude={"provenance", "template_version"}) | {"provenance": [p.model_dump() for p in self.provenance]}