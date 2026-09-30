"""Authoritative Nigerian professional reference registry.

This registry contains source metadata only. It does not copy or redistribute
copyrighted books. Retrieval/ingestion should respect each source's licence and
the source's current version/date.
"""

LAW_SOURCES = [
    {
        "id": "nigeria-constitution",
        "profession": "lawyer",
        "title": "Constitution of the Federal Republic of Nigeria, 1999 (as amended)",
        "publisher": "Policy and Legal Advocacy Centre",
        "url": "https://placng.org/i/wp-content/uploads/2023/11/Constitution-of-the-Federal-Republic-of-Nigeria-1999-Updated.pdf",
        "kind": "constitution",
        "priority": 100,
    },
    {
        "id": "nigeria-acts",
        "profession": "lawyer",
        "title": "Acts of the Federal Republic of Nigeria",
        "publisher": "Policy and Legal Advocacy Centre",
        "url": "https://placng.org/i/document_type/acts/",
        "kind": "statutes",
        "priority": 95,
    },
    {
        "id": "laws-of-nigeria-2004",
        "profession": "lawyer",
        "title": "Laws of the Federation of Nigeria 2004",
        "publisher": "Policy and Legal Advocacy Centre",
        "url": "https://lawsofnigeria.placng.org/",
        "kind": "statutes",
        "priority": 90,
        "note": "Use with post-2002 Acts; PLAC notes that LFN 2004 is not a complete current compilation.",
    },
]

DOCTOR_SOURCES = [
    {
        "id": "fmohealth-hospital-guidelines",
        "profession": "doctor",
        "title": "Federal Ministry of Health and Social Welfare clinical and hospital guidelines",
        "publisher": "Federal Ministry of Health and Social Welfare",
        "url": "https://health.gov.ng/hospital-services-policy/",
        "kind": "clinical-guidelines",
        "priority": 100,
    },
    {
        "id": "fmohealth-public-health-guidelines",
        "profession": "doctor",
        "title": "Federal Ministry of Health and Social Welfare public health policies and guidelines",
        "publisher": "Federal Ministry of Health and Social Welfare",
        "url": "https://health.gov.ng/public-health-policies/",
        "kind": "clinical-guidelines",
        "priority": 95,
    },
    {
        "id": "ncdc-guidelines",
        "profession": "doctor",
        "title": "NCDC Guidelines and Protocols",
        "publisher": "Nigeria Centre for Disease Control and Prevention",
        "url": "https://www.ncdc.gov.ng/diseases/guidelines",
        "kind": "public-health-guidelines",
        "priority": 95,
    },
    {
        "id": "fmohealth-publications",
        "profession": "doctor",
        "title": "Federal Ministry of Health and Social Welfare manuals and guides",
        "publisher": "Federal Ministry of Health and Social Welfare",
        "url": "https://health.gov.ng/publications/",
        "kind": "clinical-guidelines",
        "priority": 90,
    },
]


def sources_for_profession(profession: str) -> list[dict]:
    sources = LAW_SOURCES if profession == "lawyer" else DOCTOR_SOURCES
    return sorted(sources, key=lambda source: source["priority"], reverse=True)
