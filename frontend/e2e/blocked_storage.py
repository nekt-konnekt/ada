"""Behavioral regression for browsers where the localStorage getter is blocked."""

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:15176"
TEMPLATES = {
    "templates": [
        {
            "id": "doctor_clinical_note",
            "name": "Clinical Note",
            "version": 1,
            "profession": "doctor",
            "profession_label": "Doctor",
            "document_kind": "clinical_note",
            "custom": False,
            "sections": [{"id": "summary", "label": "Summary", "field_kind": "text"}],
        }
    ]
}

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
    page = browser.new_page()
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.add_init_script(
        """
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() { throw new DOMException('blocked localStorage getter', 'SecurityError'); }
        });
        """
    )
    page.route("**/api/templates", lambda route: route.fulfill(json=TEMPLATES))
    page.route("**/api/auth/me?**", lambda route: route.fulfill(json={"authenticated": False}))
    page.goto(BASE + "/0.1", wait_until="networkidle")

    page.get_by_role("button", name="Preferences").click()
    dialog = page.get_by_role("dialog", name="Set up Ada")
    dialog.get_by_role("button", name="Skip for now").click()
    dialog.wait_for(state="detached")

    page.get_by_role("button", name="Preferences").click()
    dialog = page.get_by_role("dialog", name="Set up Ada")
    dialog.get_by_role("button", name="Profession").click()
    dialog.get_by_role("button", name="Doctor Clinical Note").click()
    dialog.get_by_role("button", name="Language").click()
    dialog.get_by_role("button", name="Start using Ada").click()
    dialog.wait_for(state="detached")

    assert not page_errors, f"uncaught browser errors: {page_errors}"
    assert page.get_by_role("main").is_visible()
    browser.close()

print("e2e passed: app mounts and onboarding skip/completion tolerate blocked localStorage")
