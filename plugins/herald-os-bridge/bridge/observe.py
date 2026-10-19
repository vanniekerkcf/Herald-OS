"""Live steps from Hermes outside Herald OS for the Pet Room: observer hooks, off unless asked for.

Hermes runs a plugin's hooks in every process that loads it: messaging gateways, the CLI and TUI,
cron, and the backend Herald OS starts (which registers none: the Room sees that work through its
gateway). While a running Herald OS asks for live steps, each hook turns one Hermes event into a
record of fixed fields and a daemon thread sends the records in batches over that Herald OS's
control socket:

    {"cmd": "activity", "token": "<activity token>", "events": [{"kind": "tool.start", "session": "…", "tool": "read_file", "target": "Budget.xlsx", "call": "…", "source": "telegram", "at": 1760000000.5}]}

A record holds a kind, Hermes's session ids, a tool's name, a target cut to a file or folder name or
a web host, an opaque id pairing a start with its end, a status from a fixed list, where the session
runs and when the hook fired. Chat and file content, the rest of a tool's arguments, commands,
results, errors, goals, summaries and thinking never leave the hook.

A Herald OS asks by writing ``$HERMES_HOME/herald-os/observe/<pid>.json`` (0600) with ``live: true``,
its socket and a token that lets a process report activity and nothing else. Hermes waits on most of
these hooks and blocks the tool when ``pre_tool_call`` raises or stalls, so a callback swallows every
error, returns ``None`` and does no more than append to a bounded queue.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import stat
import threading
import time
from collections import OrderedDict, deque
from itertools import islice
from typing import Any, Callable, NamedTuple
from urllib.parse import urlsplit

from . import scope as _scope

REFRESH_SECONDS = 2.0
QUEUE_MAX = 512
# Herald OS reads at most this many events from one request (ROOM_ACTIVITY_BATCH).
BATCH_MAX = 100
SEND_TIMEOUT = 1.0
WAIT_SECONDS = 0.25
IDLE_SECONDS = 30.0
RETRY_SECONDS = 30.0
BUSY_SECONDS = 1.0
LABEL_MAX = 40
THREAD_NAME = "herald-room-activity"
# Hermes's own target keys (``delegate_tool_results._TOOL_INPUT_TARGET_KEYS``) in the Room's order: files, folders, addresses.
TARGET_KEYS = ("file_path", "path", "target_path", "destination_path", "new_path", "old_path", "source_path", "src", "dst", "directory", "cwd", "url", "urls", "endpoint")

_ADDRESS_KEYS = frozenset({"url", "urls", "endpoint"})
_SESSION_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
_TOOL_NAME = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
_SOURCE = re.compile(r"[a-z][a-z0-9_]{0,31}")
_CONTROL_FILE = re.compile(r"[0-9]{1,10}\.json")
_SCHEME = re.compile(r"[a-z][a-z0-9+.-]*://", re.I)
_FILE_URL = re.compile(r"file://[^/]*", re.I)
_QUERY = re.compile(r"[?#]")
_SEPARATORS = re.compile(r"[\\/]")
_SPACE = re.compile(r"\s")
# Lone surrogates too: a label must encode as UTF-8.
_UNPRINTABLE = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029\ud800-\udfff]")
# Longer than any path or address a label could name.
_VALUE_MAX = 4096
_ID_MAX = 256
_FILE_MAX = 64 * 1024
_REPLY_MAX = 64 * 1024
_PLATFORMS_MAX = 256
_DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21}
_TOOL_STATUSES = {"ok": "ok", "error": "error", "timeout": "timeout", "blocked": "blocked", "cancelled": "cancelled"}
_HELPER_STATUSES = frozenset({"completed", "failed", "error", "timeout", "interrupted"})
# Prompts a person answers; a smart approval is the auxiliary model's and waits on nobody.
_APPROVAL_SURFACES = frozenset({"cli", "gateway"})
_APPROVAL_ENDS = {"timeout": "timeout", "cancelled": "cancelled", "notify_failed": "cancelled"}
_REFUSALS = frozenset({"invalid activity token", "live detail is off"})


class _Endpoint(NamedTuple):
    """A Herald OS that asks for live steps: its control file, that file's stamp when read, its socket and token."""

    file: str
    stamp: tuple[int, ...]
    socket: str
    token: str


_queue: deque[dict[str, Any]] = deque(maxlen=QUEUE_MAX)
_wake = threading.Event()
_sender: threading.Thread | None = None
# Control file -> (its stamp, the endpoint it names or None), as last read.
_files: dict[str, tuple[tuple[int, ...], _Endpoint | None]] = {}
_endpoints: tuple[_Endpoint, ...] = ()
_checked = float("-inf")
# Shared by the sender and the hooks without a lock: each changes one atomic operation at a time.
_refused: set[_Endpoint] = set()
_backoff: dict[_Endpoint, float] = {}
_platforms: OrderedDict[str, str] = OrderedDict()


def target_of(tool: str, args: Any) -> str | None:
    """What a call works on, by name only (the Room's ``targetOf``): for ``terminal`` the folder the
    command runs in and never the command, for any other tool the first target key's file name or web host."""
    try:
        if not isinstance(args, dict):
            return None
        if tool == "terminal":
            return name_of(args.get("workdir")) or name_of(args.get("cwd"))
        for key in TARGET_KEYS:
            value = args.get(key)
            if isinstance(value, (list, tuple)):
                value = next((item for item in islice(value, 64) if isinstance(item, str)), None)
            if isinstance(value, str) and value and not value.isspace():
                return host_of(value) if key in _ADDRESS_KEYS else name_of(value)
    except Exception:
        pass
    return None


def name_of(value: Any) -> str | None:
    """A path's last segment (``~/Work/Budget.xlsx`` names ``Budget.xlsx``); an address names its host."""
    if not isinstance(value, str) or len(value) > _VALUE_MAX:
        return None
    text = " ".join(_UNPRINTABLE.sub(" ", value).split())
    if _SCHEME.match(text):
        local = _FILE_URL.match(text)
        if local is None:
            return host_of(text)
        text = _QUERY.split(text[local.end():], maxsplit=1)[0]
    last = _SEPARATORS.split(text.rstrip("\\/"))[-1].strip()
    return None if last in ("", ".", "..", "~") else _cut(last)


def host_of(value: Any) -> str | None:
    """A web address's host and port, lowercased, without credentials, path, query or fragment; a
    value without a scheme is read as ``http://<value>``, and one with spaces is no address."""
    if not isinstance(value, str) or len(value) > _VALUE_MAX:
        return None
    text = value.strip()
    if not text or _SPACE.search(text) or _UNPRINTABLE.search(text):
        return None
    try:
        parts = urlsplit(text if _SCHEME.match(text) else "http://" + text)
        host, port = parts.hostname, parts.port
    except ValueError:
        return None
    if not host:
        return None
    if ":" in host:
        host = f"[{host}]"
    if port is not None and port != _DEFAULT_PORTS.get(parts.scheme):
        host = f"{host}:{port}"
    return _cut(host)


def _cut(text: str) -> str:
    return text if len(text) <= LABEL_MAX else text[: LABEL_MAX - 1].rstrip() + "…"


def _folders() -> list[str]:
    """Where a Herald OS leaves its control file: this home's observe folder, and the root home's
    too when this home is a profile (``<root>/profiles/<name>``)."""
    home = os.path.normpath(os.environ.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes"))
    folders = [os.path.join(home, "herald-os", "observe")]
    profiles = os.path.dirname(home)
    if os.path.basename(profiles) == "profiles":
        folders.append(os.path.join(os.path.dirname(profiles), "herald-os", "observe"))
    return folders


def _stamps(folder: str) -> list[tuple[str, tuple[int, ...]]]:
    """Each control file in ``folder``, with what changes when it is rewritten or its permissions
    change: inode, mtime, size, mode and owner."""
    found: list[tuple[str, tuple[int, ...]]] = []
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if not _CONTROL_FILE.fullmatch(entry.name):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                found.append((entry.path, (info.st_ino, info.st_mtime_ns, info.st_size, info.st_mode, info.st_uid)))
    except OSError:
        pass
    return found


def _endpoint_at(file: str, stamp: tuple[int, ...]) -> _Endpoint | None:
    """The endpoint a control file names, when it asks for live steps, is a regular file and only this
    user can read it. Opened without following links or waiting on a pipe, so a hook never blocks here."""
    if not hasattr(socket, "AF_UNIX"):
        return None
    try:
        fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > _FILE_MAX:
            return None
        if hasattr(os, "getuid") and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            return None
        raw = os.read(fd, _FILE_MAX + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("live") is not True:
        return None
    path, token = data.get("socket"), data.get("token")
    if isinstance(path, str) and path and os.path.isabs(path) and isinstance(token, str) and token:
        return _Endpoint(file, stamp, path, token)
    return None


def _refresh() -> None:
    """Read the observe folders again: a file is re-read only when its stamp changed, a removed one is
    forgotten, and a refusal or back-off lasts only as long as the file it was for."""
    global _files, _endpoints
    files: dict[str, tuple[tuple[int, ...], _Endpoint | None]] = {}
    for folder in _folders():
        for file, stamp in _stamps(folder):
            known = _files.get(file)
            files[file] = known if known is not None and known[0] == stamp else (stamp, _endpoint_at(file, stamp))
    named = {endpoint for _, endpoint in files.values() if endpoint is not None}
    for endpoint in list(_refused):
        if endpoint not in named:
            _refused.discard(endpoint)
    for endpoint in list(_backoff):
        if endpoint not in named:
            _backoff.pop(endpoint, None)
    _files = files
    _endpoints = tuple(sorted(named - _refused))


def live() -> bool:
    """Whether a running Herald OS asks for live steps. The folders are read at most every
    REFRESH_SECONDS, when a hook fires; in between this is a clock read and a cached answer."""
    global _checked
    now = time.monotonic()
    if now - _checked >= REFRESH_SECONDS:
        _checked = now
        try:
            _refresh()
        except Exception:
            pass
    return bool(_endpoints)


def _reporting() -> bool:
    """A hook records something only outside Herald OS's own work and while a Herald OS asks for it."""
    return not _scope.herald_backend() and live() and not _scope.in_herald_session()


def _id(value: Any) -> str | None:
    return value if isinstance(value, str) and _SESSION_ID.fullmatch(value) else None


def _call(session: str, *values: Any) -> str | None:
    """An opaque id pairing a start with its end: the first 16 hex digits of sha256 of
    ``<session>:<Hermes's id>``, from the first of ``values`` that is set."""
    for value in values:
        if isinstance(value, str) and 0 < len(value) <= _ID_MAX:
            return hashlib.sha256(f"{session}:{value}".encode("utf-8", "surrogatepass")).hexdigest()[:16]
    return None


def _source_label(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 64:
        return None
    value = value.strip().lower()
    return value if _SOURCE.fullmatch(value) else None


def _source(session: str, platform: Any = None) -> str | None:
    """Where the session runs: the source Hermes bound for the turn, else the platform it bound, else
    the platform the hook names, else the one the session started on in this process."""
    return (
        _source_label(_scope.session_source())
        or _source_label(_scope._session_env("HERMES_SESSION_PLATFORM"))
        or _source_label(platform)
        or _platforms.get(session)
    )


def _remember(session: str, platform: Any) -> None:
    """Keep the platform a session started on for its later events; the oldest sessions are forgotten."""
    source = _source_label(platform)
    if source:
        _platforms[session] = source
        if len(_platforms) > _PLATFORMS_MAX:
            _platforms.popitem(last=False)


def _event(kind: str, session: str, platform: Any = None, **fields: Any) -> dict[str, Any]:
    """One record: its kind, the session, when the hook fired (epoch seconds), where the session runs
    when known, and those of ``fields`` that are set."""
    event: dict[str, Any] = {"kind": kind, "session": session, "at": time.time()}
    source = _source(session, platform)
    if source:
        event["source"] = source
    event.update({key: value for key, value in fields.items() if value is not None})
    return event


def _tool_ids(kwargs: dict[str, Any]) -> tuple[str | None, str | None]:
    """A tool hook's session (Hermes's session id, else its task id) and tool name, when well formed."""
    tool = kwargs.get("tool_name")
    return _id(kwargs.get("session_id")) or _id(kwargs.get("task_id")), tool if isinstance(tool, str) and _TOOL_NAME.fullmatch(tool) else None


def _on_pre_tool_call(**kwargs: Any) -> None:
    """tool.start: the tool's name, what it works on by name only, and the id pairing it with its end."""
    try:
        if not _reporting():
            return
        session, tool = _tool_ids(kwargs)
        if session and tool:
            _push(_event("tool.start", session, tool=tool, target=target_of(tool, kwargs.get("args")), call=_call(session, kwargs.get("tool_call_id"))))
    except Exception:
        pass


def _on_post_tool_call(**kwargs: Any) -> None:
    """tool.end: how the call ended, from Hermes's status alone (never its result or error text)."""
    try:
        if not _reporting():
            return
        session, tool = _tool_ids(kwargs)
        if session and tool:
            status = kwargs.get("status")
            _push(_event("tool.end", session, tool=tool, call=_call(session, kwargs.get("tool_call_id")), status=_TOOL_STATUSES.get(status) if isinstance(status, str) else None))
    except Exception:
        pass


def _on_subagent_start(**kwargs: Any) -> None:
    """helper.start: the parent's session and the helper's own id (never its goal or role)."""
    try:
        if not _reporting():
            return
        session = _id(kwargs.get("parent_session_id"))
        child = _id(kwargs.get("child_session_id")) or _id(kwargs.get("child_subagent_id"))
        if session and child:
            _push(_event("helper.start", session, child=child))
    except Exception:
        pass


def _on_subagent_stop(**kwargs: Any) -> None:
    """helper.end: how the helper ended (never its summary or its tool history)."""
    try:
        if not _reporting():
            return
        session, child = _id(kwargs.get("parent_session_id")), _id(kwargs.get("child_session_id"))
        if session and child:
            status = kwargs.get("child_status")
            _push(_event("helper.end", session, child=child, status=status if isinstance(status, str) and status in _HELPER_STATUSES else None))
    except Exception:
        pass


def _on_session_start(**kwargs: Any) -> None:
    """session.start, where the session runs from the platform Hermes names (never the model)."""
    try:
        if not _reporting():
            return
        session = _id(kwargs.get("session_id"))
        if session:
            _remember(session, kwargs.get("platform"))
            _push(_event("session.start", session, kwargs.get("platform")))
    except Exception:
        pass


def _on_session_end(**kwargs: Any) -> None:
    """session.end: interrupted, failed or completed, from Hermes's flags; none when no flag says so.
    Hermes fires it as each turn ends, not only when the conversation is over."""
    try:
        if not _reporting():
            return
        session = _id(kwargs.get("session_id"))
        if session:
            flags = [name for name in ("interrupted", "failed", "completed") if kwargs.get(name) is True]
            _push(_event("session.end", session, status=flags[0] if flags else None))
    except Exception:
        pass


def _on_pre_approval_request(**kwargs: Any) -> None:
    """approval.start (never the command, its description, its patterns or the session key)."""
    try:
        if _reporting():
            _approval("approval.start", kwargs, None)
    except Exception:
        pass


def _on_post_approval_response(**kwargs: Any) -> None:
    """approval.end: answered, timed out or cancelled (never the choice itself)."""
    try:
        if _reporting():
            choice = kwargs.get("choice")
            _approval("approval.end", kwargs, _APPROVAL_ENDS.get(choice, "answered") if isinstance(choice, str) else "answered")
    except Exception:
        pass


def _approval(kind: str, kwargs: dict[str, Any], status: str | None) -> None:
    """An approval event for a prompt a person answers, in the session Hermes binds around the tool
    call; without that session nobody can be shown waiting."""
    surface, session = kwargs.get("surface"), _id(kwargs.get("session_id"))
    if session and isinstance(surface, str) and surface in _APPROVAL_SURFACES:
        _push(_event(kind, session, call=_call(session, kwargs.get("tool_call_id"), kwargs.get("turn_id")), status=status))


HOOKS: dict[str, Callable[..., None]] = {
    "pre_tool_call": _on_pre_tool_call,
    "post_tool_call": _on_post_tool_call,
    "subagent_start": _on_subagent_start,
    "subagent_stop": _on_subagent_stop,
    "on_session_start": _on_session_start,
    "on_session_end": _on_session_end,
    "pre_approval_request": _on_pre_approval_request,
    "post_approval_response": _on_post_approval_response,
}


def register(ctx: Any) -> None:
    """Register the hooks and read the observe folders once. The backend Herald OS starts registers
    none: all its work is Herald OS's, and a ``pre_tool_call`` Hermes cannot run in time blocks the tool."""
    if _scope.herald_backend():
        return
    for name, callback in HOOKS.items():
        ctx.register_hook(name, callback)
    live()


def _push(event: dict[str, Any]) -> None:
    """Queue one event and wake the sender, starting one when none runs; never waits for it."""
    _queue.append(event)
    _wake.set()
    thread = _sender
    if thread is None or not thread.is_alive():
        _start_sender()


def _start_sender() -> None:
    global _sender
    thread = threading.Thread(target=_run, name=THREAD_NAME, daemon=True)
    _sender = thread
    thread.start()


def _run() -> None:
    """The sender: sends what the hooks queue, in batches, and stops after IDLE_SECONDS with nothing
    queued. A sender that is no longer ``_sender`` stops, so a newer one never sends beside it."""
    global _sender
    me = threading.current_thread()
    idle_since = time.monotonic()
    while _sender is me:
        _wake.wait(WAIT_SECONDS)
        _wake.clear()
        try:
            while _sender is me and _flush_once():
                idle_since = time.monotonic()
        except Exception:
            pass
        if _sender is me and time.monotonic() - idle_since >= IDLE_SECONDS:
            _sender = None
            # A hook that saw this sender before it stepped down left its event to it.
            if not _queue or _sender is not None:
                return
            _sender = me


def _flush_once() -> int:
    """Take up to BATCH_MAX queued events and send them to every Herald OS that asks for them; with
    none left to send to they are dropped. Returns how many were taken."""
    batch: list[dict[str, Any]] = []
    while len(batch) < BATCH_MAX:
        try:
            batch.append(_queue.popleft())
        except IndexError:
            break
    if batch:
        now = time.monotonic()
        for endpoint in _endpoints:
            if endpoint not in _refused and _backoff.get(endpoint, 0.0) <= now:
                _send(endpoint, batch)
    return len(batch)


def _send(endpoint: _Endpoint, events: list[dict[str, Any]]) -> None:
    """One request to one Herald OS. A refusal turns it off until its control file changes; no answer
    backs it off for RETRY_SECONDS, and a full queue on its side for BUSY_SECONDS."""
    global _checked
    line = json.dumps({"cmd": "activity", "token": endpoint.token, "events": events}, ensure_ascii=False, separators=(",", ":")) + "\n"
    reply = b""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(SEND_TIMEOUT)
            sock.connect(endpoint.socket)
            sock.sendall(line.encode("utf-8"))
            while not reply.endswith(b"\n") and len(reply) <= _REPLY_MAX:
                part = sock.recv(4096)
                if not part:
                    break
                reply += part
        answer = json.loads(reply)
    except (OSError, ValueError):
        _backoff[endpoint] = time.monotonic() + RETRY_SECONDS
        return
    error = answer.get("error") if isinstance(answer, dict) and answer.get("ok") is not True else None
    if not isinstance(error, str):
        return
    if error in _REFUSALS:
        _refused.add(endpoint)
        _checked = float("-inf")
    elif error == "too many events":
        _backoff[endpoint] = time.monotonic() + BUSY_SECONDS


def _after_fork() -> None:
    """A forked child has no sender thread, and must not send its parent's events again."""
    global _sender, _wake
    _sender, _wake = None, threading.Event()
    _queue.clear()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)
