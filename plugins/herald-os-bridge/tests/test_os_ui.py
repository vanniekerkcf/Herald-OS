"""The ``os_ui`` tool: socket client, tier mapping from the shell's catalogue, approval and audit.

A fake control server stands in for the Electron shell; ``authorize`` is captured."""

from __future__ import annotations

import importlib
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import types

import pytest


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


CATALOGUE = [
    {"id": "page.open", "title": "Open a page or app", "description": "", "tier": "read", "args": [{"name": "name", "type": "string", "required": True, "description": "Page"}], "phrases": [], "hidden": False},
    {"id": "memory.add", "title": "Remember something", "description": "", "tier": "mutate", "args": [{"name": "text", "type": "string", "required": True, "description": "Text"}], "phrases": [], "hidden": False},
    {"id": "memory.forget", "title": "Forget a memory", "description": "", "tier": "destructive", "args": [{"name": "match", "type": "string", "required": True, "description": "Match"}], "phrases": [], "hidden": False},
]


class FakeShell:
    """A JSON-lines Unix socket server answering like the Electron control server."""

    def __init__(self, path: str, token: str):
        self.path, self.token = path, token
        self.requests: list[dict] = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        self.server.listen(4)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with conn:
                data = b""
                while not data.endswith(b"\n"):
                    part = conn.recv(65536)
                    if not part:
                        break
                    data += part
                request = json.loads(data.decode())
                self.requests.append(request)
                conn.sendall((json.dumps(self._reply(request)) + "\n").encode())

    def _reply(self, request: dict) -> dict:
        if request.get("token") != self.token:
            return {"ok": False, "error": "invalid control token"}
        cmd = request.get("cmd")
        if cmd == "ui-list":
            return {"ok": True, "result": CATALOGUE}
        if cmd == "ui-state":
            return {"ok": True, "result": {"page": "overview", "windows": []}}
        if cmd == "ui":
            if request.get("command") == "page.open":
                return {"ok": True, "summary": f"Opened {request['args'].get('name')}", "page": request["args"].get("name")}
            if request.get("command") == "memory.add":
                return {"ok": True, "summary": "Remembered", "highlight": {"kind": "memory", "id": "MEMORY.md:3"}}
            return {"ok": False, "error": "nope"}
        return {"ok": False, "error": "unknown"}

    def close(self):
        self.server.close()
        try:
            os.unlink(self.path)
        except OSError:
            pass


@pytest.fixture
def shell(monkeypatch, plugin):
    # AF_UNIX paths are capped at ~104 bytes on macOS; pytest's tmp_path is far longer.
    short_dir = tempfile.mkdtemp(prefix="hos-", dir="/tmp")
    path = os.path.join(short_dir, "c.sock")
    fake = FakeShell(path, "secret-token")
    monkeypatch.setenv("HERALD_OS_CONTROL_SOCKET", path)
    monkeypatch.setenv("HERALD_OS_CONTROL_TOKEN", "secret-token")
    tools = _mod(plugin, "tools")
    tools._UI_CATALOGUE.clear()
    yield fake
    fake.close()
    tools._UI_CATALOGUE.clear()
    shutil.rmtree(short_dir, ignore_errors=True)


@pytest.fixture
def decisions(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    perm = _mod(plugin, "permissions")
    seen = []

    def authorize(tool, tier, action, summary, *, paths=()):
        seen.append((tool, tier, action, summary))
        return perm.Decision(True, "allowed")

    monkeypatch.setattr(tools, "authorize", authorize)
    return seen


@pytest.fixture
def hermes_session(monkeypatch):
    """Hermes's ``gateway.session_context``: ``bind(variables)`` binds a turn (variables it does not
    name read as ""), ``bind(None)`` binds none, so the process environment answers."""
    state: dict = {"bound": None}
    package = types.ModuleType("gateway")
    package.__path__ = []
    module = types.ModuleType("gateway.session_context")

    def get_session_env(name, default=""):
        if state["bound"] is not None:
            return state["bound"].get(name, "")
        return os.environ.get(name, default)

    module.get_session_env = get_session_env
    monkeypatch.setitem(sys.modules, "gateway", package)
    monkeypatch.setitem(sys.modules, "gateway.session_context", module)
    monkeypatch.delenv("HERMES_UI_SESSION_ID", raising=False)

    def bind(variables: dict[str, str] | None) -> None:
        state["bound"] = variables

    return bind


def test_run_read_command_through_socket(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "page.open", "args": {"name": "memory"}}))
    assert reply["success"] is True
    assert reply["page"] == "memory"
    assert decisions[-1][0] == "os_ui" and decisions[-1][1].value == "read" and decisions[-1][2] == "page.open"
    assert shell.requests[-1]["token"] == "secret-token" and shell.requests[-1]["source"] == "agent"


def test_a_command_names_the_live_session_hermes_bound(plugin, shell, decisions, hermes_session, monkeypatch):
    tools, ui = _mod(plugin, "tools"), _mod(plugin, "ui")
    hermes_session({"HERMES_UI_SESSION_ID": " a1b2c3d4 "})
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "page.open", "args": {"name": "memory"}}))
    assert reply["success"] is True
    assert shell.requests[-1] == {"cmd": "ui", "command": "page.open", "args": {"name": "memory"}, "source": "agent", "session": "a1b2c3d4", "token": "secret-token"}
    # Outside a Hermes runtime, the environment a session gave the process names it.
    monkeypatch.setitem(sys.modules, "gateway.session_context", None)
    monkeypatch.setenv("HERMES_UI_SESSION_ID", "tab-1")
    ui.run_command("page.open", {"name": "memory"})
    assert shell.requests[-1]["session"] == "tab-1"


def test_a_command_without_a_bound_session_is_sent_as_before(plugin, shell, decisions, hermes_session, monkeypatch):
    ui = _mod(plugin, "ui")
    before = {"cmd": "ui", "command": "page.open", "args": {"name": "memory"}, "source": "agent", "token": "secret-token"}
    for variables in (None, {}, {"HERMES_UI_SESSION_ID": "   "}):
        hermes_session(variables)
        ui.run_command("page.open", {"name": "memory"})
        assert shell.requests[-1] == before
    monkeypatch.setitem(sys.modules, "gateway.session_context", None)
    ui.run_command("page.open", {"name": "memory"})
    assert shell.requests[-1] == before


def test_listing_and_state_never_name_a_session(plugin, shell, decisions, hermes_session):
    tools = _mod(plugin, "tools")
    hermes_session({"HERMES_UI_SESSION_ID": "a1b2c3d4"})
    assert json.loads(tools.handle_os_ui({"action": "list"}))["success"] is True
    assert json.loads(tools.handle_os_ui({"action": "state"}))["page"] == "overview"
    assert shell.requests == [{"cmd": "ui-list", "token": "secret-token"}, {"cmd": "ui-state", "token": "secret-token"}]


def test_tier_comes_from_the_catalogue(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    json.loads(tools.handle_os_ui({"action": "run", "command": "memory.add", "args": {"text": "likes tea"}}))
    assert decisions[-1][1].value == "mutate"
    assert "likes tea" in decisions[-1][3]
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    assert tools.ui_tier_for("memory.forget", catalogue).value == "destructive"
    assert tools.ui_tier_for("mystery.command", catalogue).value == "mutate"


def test_unknown_command_is_rejected_before_authorizing(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "nope.x"}))
    assert reply["success"] is False and "unknown command" in reply["error"]
    assert not decisions


def test_list_and_state(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    listed = json.loads(tools.handle_os_ui({"action": "list"}))
    assert [c["id"] for c in listed["commands"]] == ["page.open", "memory.add", "memory.forget"]
    assert listed["commands"][0]["args"][0]["required"] is True
    state = json.loads(tools.handle_os_ui({"action": "state"}))
    assert state["page"] == "overview"


def test_shell_refusal_becomes_a_tool_error(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    tools._UI_CATALOGUE.update({"memory.forget": CATALOGUE[2]})
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "memory.forget", "args": {"match": "x"}}))
    assert reply["success"] is False and reply["error"] == "nope"


def test_string_args_are_parsed(plugin, shell, decisions):
    tools = _mod(plugin, "tools")
    reply = json.loads(tools.handle_os_ui({"action": "run", "command": "page.open", "args": '{"name": "memory"}'}))
    assert reply["success"] is True and reply["page"] == "memory"


def test_system_open_stays_inside_the_os(plugin, shell, decisions, tmp_path):
    tools = _mod(plugin, "tools")
    tools._UI_CATALOGUE.update({
        "web.open": {"id": "web.open", "title": "Open a web page", "tier": "act"},
        "file.open": {"id": "file.open", "title": "Open a file", "tier": "act"},
        "files.show": {"id": "files.show", "title": "Show in Files", "tier": "read"},
    })
    doc = tmp_path / "hello.pdf"
    doc.write_bytes(b"%PDF-1.4")
    json.loads(tools.handle_system_open({"target": "url", "url": "https://example.com"}))
    assert shell.requests[-1]["command"] == "web.open" and shell.requests[-1]["args"] == {"url": "https://example.com"}
    json.loads(tools.handle_system_open({"target": "path", "path": str(doc)}))
    assert shell.requests[-1]["command"] == "file.open" and shell.requests[-1]["args"] == {"name": str(doc)}
    json.loads(tools.handle_system_open({"target": "reveal", "path": str(doc)}))
    assert shell.requests[-1]["command"] == "files.show"
    json.loads(tools.handle_system_open({"target": "path", "path": str(tmp_path)}))
    assert shell.requests[-1]["command"] == "files.show"


def test_system_open_with_a_named_app_uses_the_host(plugin, shell, decisions, monkeypatch, tmp_path):
    tools = _mod(plugin, "tools")
    opened = []
    fake_host = type("H", (), {"open_path": lambda self, path, app: opened.append((str(path), app)), "platform": "darwin"})()
    monkeypatch.setattr(tools, "host", lambda: fake_host)
    doc = tmp_path / "hello.pdf"
    doc.write_bytes(b"%PDF-1.4")
    before = len(shell.requests)
    reply = json.loads(tools.handle_system_open({"target": "path", "path": str(doc), "app": "Preview"}))
    assert reply["success"] is True and opened == [(str(doc), "Preview")]
    assert len(shell.requests) == before


def test_system_open_editor_uses_the_first_installed_editor(plugin, shell, decisions, monkeypatch, tmp_path):
    tools = _mod(plugin, "tools")
    opened, installed = [], {"Cursor", "Zed"}
    fake_host = type("H", (), {
        "open_path": lambda self, path, app: opened.append((str(path), app)),
        "resolve_app": lambda self, name: name if name in installed else None,
        "platform": "darwin",
    })()
    monkeypatch.setattr(tools, "host", lambda: fake_host)
    reply = json.loads(tools.handle_system_open({"target": "editor", "path": str(tmp_path)}))
    assert reply["success"] is True and opened == [(str(tmp_path), "Cursor")]
    reply = json.loads(tools.handle_system_open({"target": "editor", "path": str(tmp_path), "editor": "zed"}))
    assert reply["success"] is True and opened[-1] == (str(tmp_path), "Zed")
    installed.clear()
    reply = json.loads(tools.handle_system_open({"target": "editor", "path": str(tmp_path)}))
    assert reply["success"] is False and "Visual Studio Code, Cursor, Zed" in reply["error"]


def test_without_shell_the_tool_explains(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    monkeypatch.delenv("HERALD_OS_CONTROL_SOCKET", raising=False)
    monkeypatch.delenv("HERALD_OS_CONTROL_TOKEN", raising=False)
    reply = json.loads(tools.handle_os_ui({"action": "state"}))
    assert reply["success"] is False and "control socket" in reply["error"]
