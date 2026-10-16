"""Phase 4: accounts, sessions, entitlements, server-side usage accounting."""
import pytest
from fastapi.testclient import TestClient

import app.accounts as accounts
import app.main as main
from app.main import app


def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "DB_PATH", str(tmp_path / "ada-test.db"))
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    accounts.init_db()
    return TestClient(app)


def _signup(client, email, password="hunter2boots"):
    return client.post("/api/auth/signup", json={"email": email, "password": password})


def test_signup_login_me_roundtrip(tmp_path, monkeypatch):
    client = fresh(tmp_path, monkeypatch)
    assert _signup(client, "ada@example.com").status_code == 200
    r = client.get("/api/auth/me")
    body = r.json()
    assert body["authenticated"] is True
    assert body["email"] == "ada@example.com"
    assert body["plan"] == "free"
    assert body["usage"]["limit"] == accounts.FREE_MONTHLY_LIMIT
    # duplicate signup is refused
    assert _signup(client, "ada@example.com").status_code == 409
    # invalid email / short password are refused
    assert _signup(client, "bad-email").status_code == 422
    assert _signup(client, "bad2@example.com", "short").status_code == 422


def test_login_logout(tmp_path, monkeypatch):
    client = fresh(tmp_path, monkeypatch)
    assert _signup(client, "login@example.com").status_code == 200
    cookies = dict(client.cookies)
    client.cookies.clear()
    assert client.post("/api/auth/login", json={"email": "login@example.com", "password": "WRONG"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "login@example.com", "password": "hunter2boots"}).status_code == 200
    r = client.post("/api/auth/logout")
    assert r.status_code == 200 and r.json()["authenticated"] is False
    cookie = r.headers["set-cookie"].lower()
    assert "ada_session=" in cookie
    assert "max-age=0" in cookie
    assert "expires=" in cookie
    _ = cookies


def test_usage_accounting_and_free_cap(tmp_path, monkeypatch):
    client = fresh(tmp_path, monkeypatch)
    assert _signup(client, "usage@example.com").status_code == 200
    monkeypatch.setenv("LLM_API_KEY", "test-key")

    async def successful_llm(req, template):
        result = main.local_structure(req.profession, req.notes, template_id=template.id)
        result.provider = "test-model"
        return result

    monkeypatch.setattr(main, "llm_structure", successful_llm)
    payload = {
        "profession": "founder",
        "notes": "Met with Adebayo. Decided to pause the Lekki phase. Next: budget.",
        "template_id": "founder_meeting_notes",
    }
    for i in range(accounts.FREE_MONTHLY_LIMIT):
        assert client.post("/api/structure", json=payload).status_code == 200, f"gen {i} should pass"
    limited = client.post("/api/structure", json=payload)
    assert limited.status_code == 429
    assert "Free plan monthly limit" in limited.json()["detail"]
    upgraded = client.post("/api/entitlements/upgrade-demo")
    assert upgraded.status_code == 200 and upgraded.json()["plan"] == "pro"
    assert client.post("/api/structure", json=payload).status_code == 200
    me = client.get("/api/auth/me").json()
    assert me["plan"] == "pro" and me["usage"]["limit"] is None


def test_local_fallback_does_not_charge_signed_in_user(tmp_path, monkeypatch):
    client = fresh(tmp_path, monkeypatch)
    assert _signup(client, "local@example.com").status_code == 200
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    response = client.post("/api/structure", json={"profession": "founder", "notes": "Decided to launch."})

    assert response.status_code == 200
    assert client.get("/api/auth/me").json()["usage"]["used"] == 0


def test_successful_online_result_charges_once(tmp_path, monkeypatch):
    client = fresh(tmp_path, monkeypatch)
    assert _signup(client, "online@example.com").status_code == 200

    async def successful_llm(req, template):
        result = main.local_structure(req.profession, req.notes, template_id=template.id)
        result.provider = "test-model"
        return result

    monkeypatch.setattr(main, "llm_structure", successful_llm)
    response = client.post("/api/structure", json={"profession": "founder", "notes": "Decided to launch."})

    assert response.status_code == 200
    assert client.get("/api/auth/me").json()["usage"]["used"] == 1


def test_failed_online_result_does_not_charge(tmp_path, monkeypatch):
    client = fresh(tmp_path, monkeypatch)
    assert _signup(client, "failed@example.com").status_code == 200

    async def failed_llm(req, template):
        raise main.HTTPException(502, "provider failed")

    monkeypatch.setattr(main, "llm_structure", failed_llm)
    response = client.post("/api/structure", json={"profession": "founder", "notes": "Decided to launch."})

    assert response.status_code == 502
    assert client.get("/api/auth/me").json()["usage"]["used"] == 0


def test_free_cap_is_checked_before_online_call(tmp_path, monkeypatch):
    client = fresh(tmp_path, monkeypatch)
    assert _signup(client, "capped@example.com").status_code == 200
    user = accounts._user_by_email("capped@example.com")
    assert user is not None
    for _ in range(accounts.FREE_MONTHLY_LIMIT):
        accounts.record_generation(user["id"], user["plan"])
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    called = False

    async def should_not_run(req, template):
        nonlocal called
        called = True
        return main.local_structure(req.profession, req.notes, template_id=template.id)

    monkeypatch.setattr(main, "llm_structure", should_not_run)
    response = client.post("/api/structure", json={"profession": "founder", "notes": "Decided to launch."})

    assert response.status_code == 429
    assert called is False


def test_guests_unaffected(tmp_path, monkeypatch):
    client = fresh(tmp_path, monkeypatch)
    client.cookies.clear()
    payload = {"profession": "doctor", "notes": "Patient has chest pain. BP 150/95."}
    assert client.post("/api/structure", json=payload).status_code == 200
    me = client.get("/api/auth/me").json()
    assert me["authenticated"] is False


def test_passwords_not_stored_in_plaintext(tmp_path, monkeypatch):
    client = fresh(tmp_path, monkeypatch)
    _signup(client, "hash@example.com", "hunter2boots")
    from app.accounts import _user_by_email
    row = _user_by_email("hash@example.com")
    assert "hunter2boots" not in row["password_hash"]
    assert len(row["salt"]) == 16