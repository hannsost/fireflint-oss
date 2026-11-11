#!/usr/bin/env python3
"""Real native UI regression against FireFlint's isolated release fixture.

No Expo Go, WebView or mocked API. Root provisions/starts the AVD and installs the
APK first. Tokens and UI XML stay in memory; screenshots contain synthetic data.
This script never starts/stops a host service or touches the preview database.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
ADB = ROOT / "data/mobile/toolchain/android-sdk/platform-tools/adb"
MANIFEST = ROOT / "data/local/mobile/native-fixture.json"
SERIAL = "emulator-5554"
AVD = "fireflint-mobile"
PACKAGE = "de.fireflint.mobile.dev"
API_ORIGIN = "http://127.0.0.1:18090"
SCREENSHOTS = ROOT / "docs/screenshots/2026-09-19/mobile"
RESULT = ROOT / "data/local/mobile/native-android-results.json"


class CheckFailure(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(condition: bool, message: str):
    if not condition:
        raise CheckFailure(message)


def run(command: list[str], *, timeout=35, binary=False):
    """Never include command arguments (which can contain synthetic logins) in errors."""
    result = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=timeout)
    if result.returncode:
        raise CheckFailure("External command failed with exit status " + str(result.returncode))
    return result.stdout if binary else result.stdout.decode("utf-8", errors="replace").strip()


def checked_fixture():
    require(not MANIFEST.is_symlink(), "Fixture manifest must not be a symlink")
    fixture = json.loads(MANIFEST.read_text())
    require(fixture["version"] == 1 and fixture["target"] == "release"
            and fixture["apiUrl"] == API_ORIGIN, "Wrong release fixture identity")
    uuid.UUID(fixture["fixtureId"])
    require(len(fixture["organizations"]) == 2, "Expected exactly two fixture organizations")
    for org in fixture["organizations"]:
        uuid.UUID(org["id"])
        uuid.UUID(org["contentId"])
        require(org["label"] in ("A", "B"), "Invalid organization label")
        require(org["name"] == f'FireFlint Mobile Fixture {fixture["fixtureId"]} {org["label"]}',
                "Organization is outside this synthetic fixture")
        for site in org["websites"]:
            uuid.UUID(site["id"])
            require(site["slug"].startswith(f'mobile-{fixture["fixtureId"]}-'),
                    "Website is outside this synthetic fixture")
    for key, account in fixture["accounts"].items():
        require(key in ("owner", "editor", "viewer", "revoked", "password"), "Unexpected fixture account")
        uuid.UUID(account["id"])
        require(account["email"] == f'mobile-{fixture["fixtureId"]}-{key}@example.test',
                "Account is outside this synthetic fixture")
        require(account["password"] == ("demo1234" if key == "owner" else "Mobile-Fixture-Only-2026!"),
                "Only known public synthetic test passwords are allowed")
    # Reuse the existing strict port/container/database-identity guard.
    environment = os.environ.copy()
    environment["E2E_DATABASE"] = "release"
    command = ["node", "--input-type=module", "-e",
               "import {assertReleaseTarget} from './mobile/tools/fixture.mjs'; assertReleaseTarget();"]
    result = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True, timeout=35)
    require(result.returncode == 0, "Release fixture database identity check failed")
    return fixture


class Api:
    def __init__(self, fixture):
        self.fixture = fixture
        self.tokens: dict[str, str] = {}
        owner = self.login("owner")
        require(owner["user"]["id"] == fixture["accounts"]["owner"]["id"],
                "API is not the fixture's database; refusing all mutations")
        self.tokens["owner"] = owner["access_token"]
        me = self.request("/api/me")
        expected = {org["id"]: org["name"] for org in fixture["organizations"]}
        actual = {member["org_id"]: member["org_name"] for member in me["memberships"]}
        require(actual == expected, "Fixture owner memberships do not match the exact isolated organizations")

    def request(self, path, method="GET", body=None, role="owner", expected=200):
        require(path.startswith("/") and not path.startswith("//"), "Invalid API path")
        headers = {"Accept": "application/json"}
        if role in self.tokens:
            headers["Authorization"] = "Bearer " + self.tokens[role]
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(API_ORIGIN + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.build_opener(NoRedirect).open(request, timeout=25) as response:
                status = response.status
                payload = response.read()
        except urllib.error.HTTPError as error:
            status, payload = error.code, b""
        except (urllib.error.URLError, TimeoutError):
            raise CheckFailure("The isolated fixture API is not reachable") from None
        require(status == expected, f"Fixture HTTP {method} returned {status}, expected {expected}")
        return json.loads(payload) if payload and expected < 400 else None

    def login(self, role):
        account = self.fixture["accounts"][role]
        answer = self.request("/auth/login", "POST",
                              {"email": account["email"], "password": account["password"]}, role="anonymous")
        require(answer["user"]["id"] == account["id"], "Fixture API authenticated an unexpected identity")
        self.tokens[role] = answer["access_token"]
        return answer

    @staticmethod
    def path(org):
        return f'/api/orgs/{org["id"]}/content/article/{org["contentId"]}'

    def content(self, org):
        value = self.request(self.path(org))
        require(value["org_id"] == org["id"] and value["id"] == org["contentId"],
                "Content response escaped the isolated fixture")
        return value

    def change_title(self, org, title):
        current = self.content(org)
        return self.request(self.path(org), "PUT", {
            "data": {**current["data"], "title": title}, "expected_revision": current["revision"],
        })


class Android:
    def __init__(self):
        require(ADB.is_file(), "Project-local adb is missing")
        require(self.adb("get-state") == "device", "Owned emulator is not ready")
        self.verify_identity()
        require(self.shell("getprop", "sys.boot_completed") == "1", "Owned emulator has not completed boot")
        require(self.shell("service", "check", "activity").endswith(": found")
                and self.shell("service", "check", "accessibility").endswith(": found"),
                "Owned emulator framework is not ready for native UI tests")
        require(self.shell("pm", "path", PACKAGE).startswith("package:"), "Native development APK is not installed")
        self.shell("input", "keyevent", "KEYCODE_WAKEUP")
        self.shell("wm", "dismiss-keyguard")
        size = self.shell("wm", "size")
        sizes = re.findall(r"(\d+)x(\d+)", size)
        require(bool(sizes), "Cannot determine emulator display dimensions")
        self.width, self.height = map(int, sizes[-1])

    def adb(self, *args, timeout=35, binary=False):
        return run([str(ADB), "-s", SERIAL, *args], timeout=timeout, binary=binary)

    def shell(self, *args, timeout=35):
        return self.adb("shell", *args, timeout=timeout)

    def verify_identity(self):
        name = self.adb("emu", "avd", "name").splitlines()
        require(name and name[0].strip() == AVD, "Refusing a foreign emulator/AVD")
        require(self.shell("getprop", "ro.kernel.qemu") == "1", "Refusing a physical or unidentified device")

    def launch(self, restart=False):
        self.verify_identity()
        if restart:
            self.shell("am", "force-stop", PACKAGE)
        self.shell("am", "start", "-n", PACKAGE + "/.MainActivity")

    def dump(self):
        # The XML contains only the UI tree, not app-private files or credentials.
        text = self.adb("exec-out", "uiautomator", "dump", "/proc/self/fd/1", timeout=30)
        start, end = text.find("<?xml"), text.rfind("</hierarchy>")
        if start < 0 or end < 0:
            raise CheckFailure("UI hierarchy not available yet")
        return ET.fromstring(text[start:end + len("</hierarchy>")])

    def bounds(self, node):
        values = re.fullmatch(r"\[(\d+),(\d+)]\[(\d+),(\d+)]", node.get("bounds", ""))
        if not values:
            return None
        left, top, right, bottom = map(int, values.groups())
        if right <= left or bottom <= top:
            return None
        x, y = (left + right) // 2, (top + bottom) // 2
        return (x, y) if 0 < x < self.width and 0 < y < self.height else None

    def match(self, node, *, identifier=None, text=None, exact=False):
        if identifier is not None:
            resource = node.get("resource-id", "")
            return resource == identifier or resource.endswith("/" + identifier)
        candidate = (node.get("text", "") + " " + node.get("content-desc", "")).strip()
        if exact:
            return candidate.casefold() == text.casefold()
        return text.casefold() in candidate.casefold()

    def locate(self, *, identifier=None, text=None, exact=False, timeout=18, scroll=False):
        deadline = time.monotonic() + timeout
        direction = "down"
        previous = None
        stagnant = 0
        while time.monotonic() < deadline:
            try:
                tree = self.dump()
            except (CheckFailure, ET.ParseError, subprocess.TimeoutExpired):
                time.sleep(0.25)
                continue
            for node in tree.iter("node"):
                if self.match(node, identifier=identifier, text=text, exact=exact) and self.bounds(node):
                    return node
            if scroll:
                fingerprint = ET.tostring(tree)
                stagnant = stagnant + 1 if fingerprint == previous else 0
                previous = fingerprint
                if stagnant >= 2:
                    direction = "up" if direction == "down" else "down"
                    stagnant = 0
                self.swipe(direction)
            else:
                time.sleep(0.25)
        label = identifier or text
        raise CheckFailure("Visible native element not found: " + str(label))

    def exists(self, **selector):
        try:
            self.locate(timeout=20 if selector.get("scroll") else 3, **selector)
            return True
        except CheckFailure:
            return False

    def tap(self, identifier=None, *, text=None, exact=False, scroll=True, timeout=55):
        node = self.locate(identifier=identifier, text=text, exact=exact, timeout=timeout, scroll=scroll)
        require(node.get("enabled") != "false", "Native control is disabled: " + str(identifier or text))
        x, y = self.bounds(node)
        self.shell("input", "tap", str(x), str(y))

    def swipe(self, direction):
        top, bottom = int(self.height * 0.30), int(self.height * 0.79)
        begin, end = (bottom, top) if direction == "down" else (top, bottom)
        self.shell("input", "swipe", str(self.width // 2), str(begin), str(self.width // 2), str(end), "270")

    def hide_keyboard(self):
        state = self.shell("dumpsys", "input_method")
        if re.search(r"(?:mInputShown|mIsInputViewShown|isInputViewShown)=true", state):
            self.shell("input", "keyevent", "KEYCODE_BACK")

    def fill(self, identifier, value, *, password=False):
        # All entered values are explicitly synthetic ASCII fixture values.
        require(value.isascii() and "\n" not in value and "%" not in value, "Unsupported test input")
        self.tap(identifier)
        # API30's input utility predates keycombination. These are single-line
        # fields in our own synthetic fixture, so clear their existing length
        # with portable key events instead of assuming Ctrl+A support.
        current = self.locate(identifier=identifier, timeout=12).get("text", "")
        require(len(current) <= 200, "Unexpected synthetic field length")
        self.shell("input", "keyevent", "KEYCODE_MOVE_END")
        if current:
            self.shell("input", "keyevent", *(["KEYCODE_DEL"] * len(current)))
        self.shell("input", "text", shlex.quote(value.replace(" ", "%s")))
        if not password:
            node = self.locate(identifier=identifier, timeout=8)
            require(node.get("text") == value, "Native input did not retain the synthetic value: " + identifier)
        self.hide_keyboard()

    def screenshot(self, name):
        SCREENSHOTS.mkdir(parents=True, exist_ok=True)
        path = SCREENSHOTS / (name + ".png")
        path.write_bytes(self.adb("exec-out", "screencap", "-p", binary=True))
        return str(path.relative_to(ROOT))

    def login(self, fixture, role):
        account = fixture["accounts"][role]
        self.fill("login-email", account["email"])
        self.fill("login-password", account["password"], password=True)
        self.tap("login-submit")
        self.locate(identifier="org-" + fixture["organizations"][0]["id"], timeout=35)

    def open_org(self, org):
        self.tap("org-" + org["id"])
        self.tap("content-" + org["contentId"], timeout=60)
        self.locate(text="Zentrale Inhalte", scroll=True, timeout=35)

    def logout(self):
        self.tap("logout")
        if self.exists(text="Ungespeicherte Eingaben"):
            self.tap(text="Verwerfen", exact=True, scroll=False)
        self.locate(identifier="login-email", timeout=25, scroll=True)

    def adopt_server(self):
        self.tap("conflict-compare")
        self.locate(text="Aktueller Serverstand", scroll=True, timeout=40)
        self.tap("conflict-adopt")
        self.tap(text="Serverstand übernehmen", exact=True, scroll=False)
        self.locate(text="Serverstand übernommen", scroll=True, timeout=25)


def wait_content(api, org, predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        content = api.content(org)
        if predicate(content):
            return content
        time.sleep(0.3)
    raise CheckFailure("The real API did not reach the expected native action result")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset-app", action="store_true", help="Clear only the verified own dev APK on the own AVD before testing")
    parser.add_argument("--offline", action="store_true", help="Also disable/restore networking on the verified own emulator")
    parser.add_argument("--membership", action="store_true", help="Also revoke/restore the isolated revoked-account membership")
    args = parser.parse_args()
    fixture = checked_fixture()
    api = Api(fixture)
    android = Android()
    org_a, org_b = sorted(fixture["organizations"], key=lambda org: org["label"])
    suffix = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    checks, screenshots = [], []
    report = {
        "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "device": {
            "serial": SERIAL, "avd": AVD, "package": PACKAGE,
            "android_api": android.shell("getprop", "ro.build.version.sdk"),
            "android_release": android.shell("getprop", "ro.build.version.release"),
            "abi": android.shell("getprop", "ro.product.cpu.abi"),
            "display": {"width": android.width, "height": android.height},
        },
        "fixture_id": fixture["fixtureId"], "checks": checks, "screenshots": screenshots,
        "status": "running",
    }

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    try:
        if args.reset_app:
            android.verify_identity()
            require(android.shell("pm", "clear", PACKAGE) == "Success", "Could not clear own test APK")
        android.launch()
        android.login(fixture, "editor")
        android.open_org(org_a)
        prior = api.content(org_a)
        title = "Native Freigabe " + suffix
        android.fill("field-title", title)
        screenshots.append(android.screenshot("01-native-editor"))
        android.tap("save-content")
        saved = wait_content(api, org_a, lambda value: value["data"]["title"] == title)
        require(saved["publication"] == prior["publication"], "Saving the native draft changed the public snapshot")
        android.locate(text="Entwurf gespeichert", scroll=True, timeout=35)
        passed("native editor saves real draft without changing publication")
        android.tap("editor-websites")
        android.locate(text=org_a["websites"][0]["name"], scroll=True, timeout=35)
        screenshots.append(android.screenshot("02-native-website-comparison"))
        android.locate(text=org_a["websites"][1]["name"], scroll=True, timeout=40)
        android.locate(text="lokale Ausnahme", scroll=True, timeout=40)
        android.locate(text="040 2000", scroll=True, timeout=25)
        android.tap("review-publication")
        android.tap("publish-content")
        android.tap(text="Veröffentlichen", exact=True, scroll=False)
        published = wait_content(api, org_a, lambda value: value["publication"]["data"]["title"] == title)
        require(published["publication"]["revision"] == published["revision"], "Published revision mismatch")
        overrides = {a["website_id"]: a.get("overrides") or {} for a in published["publication"]["assignments"]}
        require(overrides[org_a["websites"][1]["id"]]["phone"] == "040 2000", "Native publication lost local override")
        android.locate(text="Veröffentlicht. Die Websites", scroll=True, timeout=35)
        screenshots.append(android.screenshot("03-native-published"))
        passed("native website comparison and explicitly checked publication reach real API")

        android.launch(restart=True)
        android.locate(identifier="org-" + org_a["id"], timeout=35)
        require(not android.exists(identifier="login-email"), "SecureStore session was not restored")
        android.open_org(org_b)
        node = android.locate(identifier="field-title", scroll=True, timeout=25)
        require(node.get("text") == "Standort B", "Organization B did not display its own content")
        require(not android.exists(text=title), "Organization A draft leaked into B")
        screenshots.append(android.screenshot("04-native-other-organization"))
        android.tap("org-switch")
        android.open_org(org_a)
        node = android.locate(identifier="field-title", scroll=True, timeout=25)
        require(node.get("text") == title, "Explicit organization switch did not restore A's own content")
        passed("native force-stop/relaunch restores secure session; explicit organization switching isolates A and B")
        android.logout()
        android.launch(restart=True)
        android.locate(identifier="login-email", timeout=35, scroll=True)
        require(not android.exists(identifier="org-" + org_a["id"]), "Logout restored an old session")
        passed("native logout removes the stored login across process restart")

        android.login(fixture, "viewer")
        android.open_org(org_a)
        require(not android.exists(identifier="field-title"), "Viewer has an editable title field")
        require(not android.exists(identifier="save-content", scroll=True), "Viewer has an active save control")
        android.locate(text="Du hast Lesezugriff", scroll=True, timeout=25)
        screenshots.append(android.screenshot("05-native-viewer"))
        android.tap("editor-websites")
        require(not android.exists(identifier="review-publication", scroll=True), "Viewer has a publication review control")
        require(not android.exists(identifier="publish-content", scroll=True), "Viewer has a publication write control")
        api.login("viewer")
        before = api.content(org_a)
        api.request(api.path(org_a), "PUT", {"data": before["data"], "expected_revision": before["revision"]}, role="viewer", expected=403)
        require(api.content(org_a) == before, "Viewer's rejected write changed real content")
        passed("native viewer is readable without write controls; actual server rejects forged write")
        android.logout()

        android.login(fixture, "editor")
        android.open_org(org_a)
        local_title, server_title = "Lokale Eingabe " + suffix, "Paralleler Serverstand " + suffix
        android.fill("field-title", local_title)
        concurrent = api.change_title(org_a, server_title)
        android.tap("save-content")
        android.locate(text="inzwischen geändert", scroll=True, timeout=35)
        local = android.locate(identifier="field-title", scroll=True, timeout=30)
        require(local.get("text") == local_title, "Stale 409 erased native inputs")
        require(api.content(org_a) == concurrent, "Stale native write changed the server state")
        screenshots.append(android.screenshot("06-native-conflict-inputs"))
        android.tap("conflict-compare")
        android.locate(text="Aktueller Serverstand", scroll=True, timeout=30)
        require(api.content(org_a) == concurrent, "Read-only conflict comparison wrote to the server")
        screenshots.append(android.screenshot("07-native-conflict-comparison"))
        android.adopt_server()
        passed("real native stale 409 preserves inputs; comparison never auto-retries a write")

        if args.offline:
            android.fill("field-title", "Offline Eingabe " + suffix)
            before = api.content(org_a)
            android.verify_identity()
            airplane = android.shell("settings", "get", "global", "airplane_mode_on")
            wifi = android.shell("settings", "get", "global", "wifi_on")
            mobile_data = android.shell("settings", "get", "global", "mobile_data")
            require(airplane == "0" and wifi == "1", "Offline test requires an initially online own emulator")
            try:
                android.shell("cmd", "connectivity", "airplane-mode", "enable")
                android.shell("svc", "wifi", "disable")
                android.shell("svc", "data", "disable")
                android.tap("save-content")
                android.locate(text="Keine verlässliche Verbindung", scroll=True, timeout=45)
                node = android.locate(identifier="field-title", scroll=True, timeout=25)
                require(node.get("text") == "Offline Eingabe " + suffix, "Offline failure erased native input")
                require(api.content(org_a) == before, "Offline write unexpectedly reached the server")
                screenshots.append(android.screenshot("08-native-offline"))
            finally:
                android.shell("cmd", "connectivity", "airplane-mode", "disable")
                android.shell("svc", "wifi", "enable")
                android.shell("svc", "data", "enable" if mobile_data == "1" else "disable")
            # Observe recovery without triggering any content action.
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                require(api.content(org_a) == before, "Reconnection automatically repeated an offline write")
                time.sleep(0.4)
            android.adopt_server()
            passed("own emulator offline inputs survive and reconnection performs no automatic write")

        android.logout()
        if args.membership:
            android.login(fixture, "revoked")
            android.open_org(org_a)
            account = fixture["accounts"]["revoked"]
            path = f'/api/orgs/{org_a["id"]}/members'
            try:
                api.request(path + "/" + account["id"], "DELETE", expected=204)
                android.shell("input", "keyevent", "KEYCODE_HOME")
                android.launch()
                android.locate(text="kein Arbeitsbereich zugeordnet", timeout=35, scroll=True)
                require(not android.exists(identifier="content-" + org_a["contentId"]), "Revoked membership kept private content visible")
                require(not android.exists(identifier="field-title"), "Revoked membership kept an editor visible")
                screenshots.append(android.screenshot("09-native-membership-revoked"))
                passed("native foreground revalidation clears revoked membership and private content")
            finally:
                api.request(path, "POST", {"email": account["email"], "role": "editor"})
            android.tap("chooser-logout")
            android.locate(identifier="login-email", scroll=True, timeout=25)

        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        # Errors never include argv, HTTP response bodies, tokens, or full UI dumps.
        report["failure"] = str(error) if isinstance(error, CheckFailure) else type(error).__name__
        try:
            screenshots.append(android.screenshot("failure-native"))
        except Exception:
            pass
        raise
    finally:
        report["finished_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        RESULT.parent.mkdir(parents=True, exist_ok=True)
        RESULT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "passed", "checks": len(checks), "report": str(RESULT.relative_to(ROOT))}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except CheckFailure as error:
        print("FAIL " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print("FAIL " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
