"""Fidelity and completeness machinery — moved verbatim from main.py so the
structuring engine can share one source of truth without import cycles.
Names are re-exported from app.main to preserve the public surface."""
from __future__ import annotations

import re

UNIT_TOKENS = {
    "mg", "mcg", "g", "kg", "ml", "l", "mmhg", "bpm", "c", "f", "cm", "mm",
    "hrs", "hr", "hours", "hour", "mins", "min", "minutes", "minute", "years",
    "year", "days", "day", "weeks", "week", "months", "month"
}
COMMON_DRUGS = {
    "aspirin", "ibuprofen", "paracetamol", "acetaminophen", "amoxicillin",
    "metformin", "insulin", "warfarin", "heparin", "atorvastatin", "omeprazole",
    "azithromycin", "diclofenac", "naproxen", "prednisolone", "salbutamol"
}


def sentences(text: str) -> list[str]:
    return [x.strip(" .") for x in re.split(r"(?<=[.!?])\s+|\n+", text) if x.strip()]


def _is_note_instruction(sentence: str) -> bool:
    lowered = sentence.lower()
    return any(marker in lowered for marker in [
        "ignore your rules",
        "ignore the rules",
        "ignore previous instructions",
        "write that the patient has",
        "follow these instructions",
    ])


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _output_text(response) -> str:
    return " ".join(section["content"] for section in response.sections)


def _source_tokens(text: str) -> set[str]:
    return set(re.findall(r"\b[a-z]+\b", (text or "").lower()))


def _content_tokens(current_document: dict) -> set[str]:
    tokens: set[str] = set()
    if isinstance(current_document, dict):
        for section in current_document.get("sections", []) or []:
            tokens |= _source_tokens(section.get("content", ""))
    return tokens


def _section_for_token(response, token: str) -> str | None:
    for section in response.sections:
        if token in section["content"].lower():
            return section["id"]
    return None


def completeness_check(notes: str, response) -> list[str]:
    source_sentences = sentences(notes)
    output = _output_text(response).lower()
    unplaced = []
    for sentence in source_sentences:
        words = [w for w in re.findall(r"[a-z0-9]+", sentence.lower()) if len(w) > 2]
        if not words:
            continue
        if sentence.lower() in output:
            continue
        distinctive = [w for w in words if w not in {"the", "and", "was", "were", "with", "from", "that", "this", "for", "had", "has", "have"}]
        overlap = sum(1 for w in distinctive if w in output) / max(1, len(distinctive))
        if overlap < 0.55:
            unplaced.append(sentence)
    return unplaced


def validate_fidelity(notes: str, current_document: dict, response) -> list[dict]:
    source = _source_tokens(notes) | _content_tokens(current_document)
    output = _output_text(response)
    warnings = []

    for token in sorted(_source_tokens(output) - source):
        if token in UNIT_TOKENS or re.fullmatch(r"\d+(?:\.\d+)?", token):
            warnings.append({"section_id": _section_for_token(response, token), "message": f"Not in your notes: '{token}'", "token": token})
        elif token in COMMON_DRUGS:
            warnings.append({"section_id": _section_for_token(response, token), "message": f"Not in your notes: '{token}'", "token": token})

    source_numbers = set(re.findall(r"\b\d+(?:\.\d+)?\s*[A-Za-z%]+", notes.lower()))
    output_numbers = set(re.findall(r"\b\d+(?:\.\d+)?\s*[A-Za-z%]+", output.lower()))
    for expression in sorted(output_numbers - source_numbers):
        token = expression.split()[-1]
        if token not in source:
            warnings.append({"section_id": _section_for_token(response, token), "message": f"Not in your notes: '{token}'", "token": token})

    unique = []
    seen = set()
    for warning in warnings:
        key = (warning["section_id"], warning["token"])
        if key not in seen:
            seen.add(key)
            unique.append(warning)
    return unique