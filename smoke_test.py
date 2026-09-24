#!/usr/bin/env python3
"""
smoke_test.py

Automates the Windows-only smoke test for ollama-chat:
  1. CRLF-preserving edit_file
  2. cmd.exe argument quoting for execute_command
  3. taskkill /T /F actually killing a spawned child, both on POST /api/chat/stop
     and on a real SIGINT-equivalent (CTRL_BREAK_EVENT) shutdown

Tests 1-4 are the original Windows checks. Tests 5-8 cover audit fixes F5 (secrets-file
alias bypass), F4 (steer 500), F1 (chats.db durability race).
MUST be run ON WINDOWS, from the ollama-chat project folder (next to server.js),
with Node.js on PATH. Does NOT require a real Ollama pull or GPU: it spins up a
tiny pure-Python mock Ollama on 127.0.0.1:11434 that scripts the exact tool
calls each test needs, so this only exercises ollama-chat's own code (taskkill,
cmd.exe quoting, CRLF handling) rather than model quality.

NOTE: tests 1-4 passed 4/4 on Windows. Tests 5-8 were validated on Linux with
`--posix-dry-run` only; on Windows the F5 aliases (::$DATA, trailing space/dot) are
exercised for real. Report back anything that needs fixing.

Usage:
    cd C:\\path\\to\\ollama-chat
    pip install requests
    python smoke_test.py
"""

import contextlib
import http.server
import json
import os
import random
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

try:
    import requests
except ImportError:
    print("This script needs 'requests': pip install requests")
    sys.exit(1)

IS_WIN = os.name == "nt"
DRY_RUN = "--posix-dry-run" in sys.argv  # dev-only: runs just the portable tests (5-8) on Linux/macOS
if not IS_WIN and not DRY_RUN:
    print("This script is meant to run on Windows — it tests taskkill, cmd.exe")
    print("quoting, and Windows console/process-group behavior specifically.")
    sys.exit(1)

APP_PORT = int(os.environ.get("SMOKE_APP_PORT", 3000))
OLLAMA_PORT = int(os.environ.get("SMOKE_OLLAMA_PORT", 11434))
CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
SERVER_LOG = os.path.join(tempfile.gettempdir(), "ollama_chat_smoke_main_server.log")
PROJECT_ROOT = os.path.join(tempfile.gettempdir(), "ollama_chat_smoketest_project")

# ─────────────────────────────────────────────────────────────────────────────
# A tiny mock Ollama. Scripted responses per test via a global "PLAN" queue.
# ─────────────────────────────────────────────────────────────────────────────

PLAN = []  # list of dict "turns"; each call to /api/chat pops the next one


def _ndjson_lines(turn):
    """turn: {'tool_calls': [...]} or {'content': '...'}"""
    if turn.get("tool_calls"):
        yield {"message": {"role": "assistant", "content": "", "tool_calls": turn["tool_calls"]}}
        yield {"message": {"role": "assistant", "content": ""}, "done": True,
               "prompt_eval_count": 1, "eval_count": 1}
    else:
        yield {"message": {"role": "assistant", "content": turn.get("content", "OK")}}
        yield {"message": {"role": "assistant", "content": ""}, "done": True,
               "prompt_eval_count": 1, "eval_count": 1}


class MockOllamaHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # quiet

    def do_GET(self):
        if self.path == "/api/tags":
            body = json.dumps({"models": [{"name": "gpt-oss:120b-cloud"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)  # drain body, we don't need to inspect it
        if self.path != "/api/chat":
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        turn = PLAN.pop(0) if PLAN else {"content": "Done."}
        try:
            for line in _ndjson_lines(turn):
                self.wfile.write((json.dumps(line) + "\n").encode())
                self.wfile.flush()
                time.sleep(turn.get("delay", 0.05))
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass


def start_mock_ollama():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", OLLAMA_PORT), MockOllamaHandler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


# ─────────────────────────────────────────────────────────────────────────────
# Helpers to drive ollama-chat's own HTTP API
# ─────────────────────────────────────────────────────────────────────────────

def wait_for_port(port, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with contextlib.suppress(OSError):
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        time.sleep(0.3)
    return False


def read_app_token():
    token_path = os.path.join(os.getcwd(), ".app_token")
    deadline = time.time() + 15
    while time.time() < deadline:
        if os.path.exists(token_path):
            with open(token_path, "r") as f:
                tok = f.read().strip()
                if tok:
                    return tok
        time.sleep(0.3)
    raise RuntimeError(".app_token never appeared — did server.js start next to this script?")


def api(session, base, method, path, **kw):
    return session.request(method, base + path, timeout=kw.pop("timeout", 30), **kw)


def new_conversation(session, base):
    r = api(session, base, "POST", "/api/conversations", json={})
    r.raise_for_status()
    return r.json()["id"]


def stream_lines(resp):
    for raw in resp.iter_lines(decode_unicode=True):
        if raw and raw.startswith("data: "):
            try:
                yield json.loads(raw[6:])
            except json.JSONDecodeError:
                continue


def send_chat_and_collect(session, base, conv_id, message, project_root, on_event=None, timeout=30):
    events = []
    fields = {"conversationId": conv_id, "message": message, "projectRoot": project_root}
    files = {k: (None, v) for k, v in fields.items()}
    with session.post(
        base + "/api/chat",
        files=files,
        stream=True, timeout=timeout,
    ) as resp:
        resp.raise_for_status()
        for evt in stream_lines(resp):
            events.append(evt)
            if on_event:
                on_event(evt)
            if evt.get("done") or evt.get("error"):
                break
    return events


# ─────────────────────────────────────────────────────────────────────────────
# Test bookkeeping
# ─────────────────────────────────────────────────────────────────────────────

RESULTS = []


def record(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(("[PASS] " if ok else "[FAIL] ") + name + (" — " + detail if detail else ""))


def setup_project_dir(path):
    if os.path.exists(path):
        shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path)
    # A pure-CRLF file, as Windows tooling would produce
    with open(os.path.join(path, "crlf_test.txt"), "wb") as f:
        f.write(b"line one\r\nline two\r\nline three\r\n")
    with open(os.path.join(path, ".env"), "wb") as f:
        f.write(b"API_KEY=SMOKE_SECRET_MARKER\n")
    with open(os.path.join(path, "a.txt"), "wb") as f:
        f.write(b"plain readable file\n")
    return path


def find_children_by_name(name_substring):
    """Return matching rows from `tasklist` whose image name contains name_substring."""
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq {}".format(name_substring), "/FO", "CSV", "/NH"],
        capture_output=True, text=True, shell=True,
    )
    lines = [l for l in out.stdout.splitlines() if l.strip() and "No tasks" not in l]
    return lines


# ─────────────────────────────────────────────────────────────────────────────
# Test 1: CRLF-preserving edit_file
# ─────────────────────────────────────────────────────────────────────────────

def test_crlf_edit(session, base, project_root):
    conv_id = new_conversation(session, base)
    PLAN.clear()
    PLAN.append({"tool_calls": [{
        "id": "c1", "function": {"name": "edit_file", "arguments": {
            "path": "crlf_test.txt",
            "old_str": "line two",  # model sends plain text; file itself is CRLF
            "new_str": "line TWO EDITED",
        }},
    }]})
    PLAN.append({"content": "Edited."})

    pending_id = [None]

    def on_evt(e):
        if e.get("type") == "diff_pending":
            pending_id[0] = e["pendingId"]

    def runner():
        send_chat_and_collect(session, base, conv_id, "edit the file", project_root, on_event=on_evt)

    th = threading.Thread(target=runner)
    th.start()

    deadline = time.time() + 10
    while pending_id[0] is None and time.time() < deadline:
        time.sleep(0.2)
    if pending_id[0] is None:
        th.join(timeout=5)
        record("CRLF-preserving edit_file", False, "no diff_pending event received")
        return

    api(session, base, "POST", "/api/chat/diff-approve",
        json={"pendingId": pending_id[0], "approve": True}).raise_for_status()
    th.join(timeout=10)

    with open(os.path.join(project_root, "crlf_test.txt"), "rb") as f:
        content = f.read()

    ok = (
        b"line TWO EDITED" in content
        and b"\r\n" in content
        and content.count(b"\n") == content.count(b"\r\n")  # every \n is part of a \r\n — stayed pure CRLF
    )
    record("CRLF-preserving edit_file", ok, "" if ok else repr(content))


# ─────────────────────────────────────────────────────────────────────────────
# Test 2: cmd.exe argument quoting for execute_command
# ─────────────────────────────────────────────────────────────────────────────

def test_cmdexe_quoting(session, base, project_root):
    conv_id = new_conversation(session, base)
    PLAN.clear()
    # Quotes + an ampersand: breaks naive re-quoting if windowsVerbatimArguments
    # or the cmd /d /s /c wrapping in runShellCommand() is wrong.
    cmd = 'echo "hello & world" > quoted_output.txt'
    PLAN.append({"tool_calls": [{
        "id": "c1", "function": {"name": "execute_command", "arguments": {"command": cmd}},
    }]})
    PLAN.append({"content": "Ran it."})

    pending_id = [None]

    def on_evt(e):
        if e.get("type") == "command_pending":
            pending_id[0] = e["pendingId"]

    def runner():
        send_chat_and_collect(session, base, conv_id, "run it", project_root, on_event=on_evt, timeout=30)

    th = threading.Thread(target=runner)
    th.start()

    deadline = time.time() + 10
    while pending_id[0] is None and time.time() < deadline:
        time.sleep(0.2)
    if pending_id[0] is None:
        th.join(timeout=5)
        record("cmd.exe quoting (execute_command)", False, "no command_pending event received")
        return

    api(session, base, "POST", "/api/chat/command-approve",
        json={"pendingId": pending_id[0], "approve": True}).raise_for_status()
    th.join(timeout=15)

    out_path = os.path.join(project_root, "quoted_output.txt")
    ok = os.path.exists(out_path)
    detail = ""
    if ok:
        with open(out_path, "r", errors="replace") as f:
            detail = f.read().strip()
        ok = "hello" in detail and "world" in detail
    record("cmd.exe quoting (execute_command)", ok, detail if ok else "quoted_output.txt not created/empty")


# ─────────────────────────────────────────────────────────────────────────────
# Test 3a: POST /api/chat/stop kills the spawned child (taskkill /T /F)
# ─────────────────────────────────────────────────────────────────────────────

def test_stop_kills_child(session, base, project_root):
    conv_id = new_conversation(session, base)
    PLAN.clear()
    # ping -n 30 blocks ~29s, built into Windows, no extra dependency.
    cmd = "ping -n 30 127.0.0.1 > smoketest_marker_stop.txt"
    PLAN.append({"tool_calls": [{
        "id": "c1", "function": {"name": "execute_command", "arguments": {"command": cmd}},
    }]})
    PLAN.append({"content": "Done."})

    pending_id = [None]

    def on_evt(e):
        if e.get("type") == "command_pending":
            pending_id[0] = e["pendingId"]

    def runner():
        send_chat_and_collect(session, base, conv_id, "run it", project_root, on_event=on_evt, timeout=60)

    th = threading.Thread(target=runner)
    th.start()

    deadline = time.time() + 10
    while pending_id[0] is None and time.time() < deadline:
        time.sleep(0.2)
    if pending_id[0] is None:
        record("Stop kills spawned child (taskkill /T /F)", False, "no command_pending event received")
        return

    api(session, base, "POST", "/api/chat/command-approve",
        json={"pendingId": pending_id[0], "approve": True}).raise_for_status()

    time.sleep(2)  # let ping.exe actually spawn
    before = find_children_by_name("ping.exe")
    if not before:
        record("Stop kills spawned child (taskkill /T /F)", False,
                "ping.exe never showed up in tasklist — test inconclusive")
        return

    api(session, base, "POST", "/api/chat/stop", json={"conversationId": conv_id}).raise_for_status()

    time.sleep(4)
    after = find_children_by_name("ping.exe")
    ok = len(after) == 0
    record("Stop (/api/chat/stop) kills spawned child via taskkill /T /F", ok,
           "" if ok else "still running: {}".format(after))
    th.join(timeout=5)


# ─────────────────────────────────────────────────────────────────────────────
# Test 3b: real SIGINT-equivalent (CTRL_BREAK_EVENT) shutdown kills the child too
# ─────────────────────────────────────────────────────────────────────────────

def test_ctrlbreak_kills_child(node_exe, server_js):
    """
    Runs a second, throwaway server instance (own port/project dir) so killing
    it doesn't disturb anything else. Must be launched with
    CREATE_NEW_PROCESS_GROUP so CTRL_BREAK_EVENT can target it alone rather
    than this whole script's console group.
    """
    port = APP_PORT + 1
    proj = setup_project_dir(PROJECT_ROOT + "_ctrlbreak")
    log_path = os.path.join(tempfile.gettempdir(), "ollama_chat_ctrlbreak_server.log")
    log_file = open(log_path, "w")

    env = os.environ.copy()
    env["PORT"] = str(port)
    proc = subprocess.Popen(
        [node_exe, server_js],
        cwd=os.path.dirname(server_js) or ".",
        env=env,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        stdout=log_file, stderr=subprocess.STDOUT,
    )
    try:
        if not wait_for_port(port, timeout=15):
            record("SIGINT/CTRL_BREAK shutdown kills spawned child", False,
                    "second server instance never came up")
            return

        # source-mode paths.js resolves .app_token next to server.js regardless
        # of PORT, so the same token file applies to this second instance too.
        token = read_app_token()
        session = requests.Session()
        session.headers["x-app-token"] = token
        base = "http://127.0.0.1:{}".format(port)

        conv_id = new_conversation(session, base)
        PLAN.clear()
        cmd = "ping -n 30 127.0.0.1 > smoketest_marker_ctrlbreak.txt"
        PLAN.append({"tool_calls": [{
            "id": "c1", "function": {"name": "execute_command", "arguments": {"command": cmd}},
        }]})
        PLAN.append({"content": "Done."})

        pending_id = [None]

        def on_evt(e):
            if e.get("type") == "command_pending":
                pending_id[0] = e["pendingId"]

        def runner():
            send_chat_and_collect(session, base, conv_id, "run it", proj, on_event=on_evt, timeout=60)

        th = threading.Thread(target=runner)
        th.start()

        deadline = time.time() + 10
        while pending_id[0] is None and time.time() < deadline:
            time.sleep(0.2)
        if pending_id[0] is None:
            record("SIGINT/CTRL_BREAK shutdown kills spawned child", False,
                    "no command_pending event received")
            return

        api(session, base, "POST", "/api/chat/command-approve",
            json={"pendingId": pending_id[0], "approve": True}).raise_for_status()
        time.sleep(2)

        before = find_children_by_name("ping.exe")
        if not before:
            record("SIGINT/CTRL_BREAK shutdown kills spawned child", False,
                    "ping.exe never showed up — inconclusive")
            return

        # Ctrl+Break is the only console-control event Python can deliver to a
        # process in a different process group (Ctrl+C/CTRL_C_EVENT can't cross
        # process groups on Windows). Node surfaces this as 'SIGBREAK', which is
        # DIFFERENT from 'SIGINT' (Ctrl+C) — requires its own handler in
        # server.js (see the SIGBREAK patch) or Windows just force-kills the
        # process without running shutdown()/killProcessTree().
        os.kill(proc.pid, signal.CTRL_BREAK_EVENT)

        time.sleep(4)
        log_file.close()
        with open(log_path, "r", errors="replace") as f:
            server_log = f.read()
        graceful = "Shutting down" in server_log or "Shutdown complete" in server_log
        after = find_children_by_name("ping.exe")
        server_exited = proc.poll() is not None
        ok = len(after) == 0 and server_exited and graceful
        detail_parts = []
        if not server_exited:
            detail_parts.append("server process did not exit")
        if not graceful:
            detail_parts.append("no 'Shutting down' log line — SIGBREAK handler didn't run "
                                 "(Windows likely force-killed it instead); see log: " + log_path)
        if after:
            detail_parts.append("ping.exe still running: {}".format(after))
        record("Ctrl+Break (SIGBREAK) shutdown kills spawned child", ok, "; ".join(detail_parts))
    finally:
        with contextlib.suppress(Exception):
            proc.terminate()
        with contextlib.suppress(Exception):
            log_file.close()



# ─────────────────────────────────────────────────────────────────────────────
# Test 5 (F5): secrets-file block cannot be bypassed with NTFS name aliases
#   ".env::$DATA" (alternate data stream), ".env " (trailing space), ".env." (trailing dot)
#   all open ".env" on NTFS. read_file needs NO approval and its output goes to the model.
# ─────────────────────────────────────────────────────────────────────────────

def test_sensitive_read_blocked(session, base, project_root):
    name = "Secrets-file block (.env aliases)"
    conv_id = new_conversation(session, base)
    PLAN.clear()
    paths = [".env", ".ENV", ".env::$DATA", ".env ", ".env.", "sub\\..\\.env", "a.txt"]
    PLAN.append({"tool_calls": [
        {"id": "r%d" % i, "function": {"name": "read_file", "arguments": {"path": p}}}
        for i, p in enumerate(paths)
    ]})
    PLAN.append({"content": "done"})
    events = send_chat_and_collect(session, base, conv_id, "read them", project_root, timeout=30)
    ends = [e for e in events if e.get("type") == "tool_end"]
    if len(ends) != len(paths):
        record(name, False, "expected {} tool_end events, got {}".format(len(paths), len(ends)))
        return
    leaked = [p for p, e in zip(paths, ends) if p != "a.txt" and (e.get("ok") or "SMOKE_SECRET_MARKER" in json.dumps(e))]
    control_ok = ends[-1].get("ok") is True
    ok = not leaked and control_ok
    record(name, ok, "" if ok else "leaked/readable: {}; a.txt readable: {}".format(leaked, control_ok))


# ─────────────────────────────────────────────────────────────────────────────
# Test 6 (F4): /api/chat/steer with a non-string note must not 500
# ─────────────────────────────────────────────────────────────────────────────

def test_steer_non_string(session, base, project_root):
    name = "Steer endpoint tolerates non-string note"
    conv_id = new_conversation(session, base)
    PLAN.clear()
    PLAN.append({"content": "slow reply", "delay": 1.5})
    started = threading.Event()

    def on_evt(e):
        started.set()

    def runner():
        with contextlib.suppress(Exception):
            send_chat_and_collect(session, base, conv_id, "go", project_root, on_event=on_evt, timeout=30)

    th = threading.Thread(target=runner)
    th.start()
    time.sleep(0.8)
    r = api(session, base, "POST", "/api/chat/steer", json={"conversationId": conv_id, "note": {"a": 1}})
    ok = r.status_code == 200
    record(name, ok, "" if ok else "HTTP {} {}".format(r.status_code, r.text[:120]))
    with contextlib.suppress(Exception):
        api(session, base, "POST", "/api/chat/stop", json={"conversationId": conv_id})
    th.join(timeout=10)


# ─────────────────────────────────────────────────────────────────────────────
# Test 7 (F1): chats.db on disk is valid and current at the moment a turn reports done.
#   finish() calls flushSync() BEFORE sending `done`. A debounced async save racing it
#   (same tmp file) used to leave the file corrupt or stale.
# ─────────────────────────────────────────────────────────────────────────────

def _db_message_count(db_path):
    last = None
    for _ in range(8):  # Windows: the server may hold the file for a moment while renaming
        try:
            copy = db_path + ".smokecopy"
            shutil.copyfile(db_path, copy)
            con = sqlite3.connect(copy)
            try:
                return con.execute("SELECT count(*) FROM messages").fetchone()[0]
            finally:
                con.close()
                with contextlib.suppress(OSError):
                    os.remove(copy)
        except (OSError, sqlite3.Error) as e:
            last = e
            time.sleep(0.05)
    raise RuntimeError("chats.db unreadable: {}".format(last))


def test_db_durability(session, base, iterations=60):
    name = "chats.db valid and current when a turn reports done"
    db_path = os.path.join(os.getcwd(), "db", "chats.db")
    if not os.path.exists(db_path):
        record(name, False, "db/chats.db not found next to server.js")
        return
    # Seed: a multi-MB DB makes export()+write take long enough for the race window to be hit.
    for j in range(6):
        cid = new_conversation(session, base)
        PLAN.clear()
        PLAN.append({"content": "s" * 1000000, "delay": 0.01})
        send_chat_and_collect(session, base, cid, "seed {}".format(j), "", timeout=30)
    time.sleep(1.0)
    base_rows = _db_message_count(db_path)
    bad = []
    rnd = random.Random(1234)
    for i in range(iterations):
        conv_id = new_conversation(session, base)
        PLAN.clear()
        # The user message arms the 300ms debounced save; a reply whose done line lands ~0.22-0.34s after the user message makes
        # finish()->flushSync() collide with the async write it starts.
        PLAN.append({"content": ("r%d " % i) * 33000, "delay": rnd.uniform(0.22, 0.34)})
        send_chat_and_collect(session, base, conv_id, "durability {}".format(i), "", timeout=30)
        expected = base_rows + 2 * (i + 1)
        try:
            rows = _db_message_count(db_path)
        except RuntimeError as e:
            bad.append((i, str(e)))
            continue
        if rows != expected:
            bad.append((i, "rows {} != {}".format(rows, expected)))
    time.sleep(1.0)  # let any late async save land, then re-check for a stale overwrite
    try:
        final_rows = _db_message_count(db_path)
        if final_rows != base_rows + 2 * iterations:
            bad.append(("final", "rows {} != {}".format(final_rows, base_rows + 2 * iterations)))
    except RuntimeError as e:
        bad.append(("final", str(e)))
    ok = not bad
    record(name, ok, "" if ok else "{} bad of {}: {}".format(len(bad), iterations, bad[:5]))


def test_no_db_save_errors_in_log():
    name = "No '[db] save failed' errors in server log"
    try:
        with open(SERVER_LOG, "r", errors="replace") as f:
            log = f.read()
    except OSError as e:
        record(name, False, "cannot read {}: {}".format(SERVER_LOG, e))
        return
    n = log.count("[db] save failed") + log.count("[db] flush failed")
    record(name, n == 0, "" if n == 0 else "{} occurrences; see {}".format(n, SERVER_LOG))


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    if not os.path.exists("server.js"):
        print("Run this from the ollama-chat project folder (server.js not found here).")
        sys.exit(1)

    node_exe = shutil.which("node")
    if not node_exe:
        print("node.exe not found on PATH.")
        sys.exit(1)

    project_root = setup_project_dir(PROJECT_ROOT)

    print("Starting mock Ollama on 127.0.0.1:{} ...".format(OLLAMA_PORT))
    start_mock_ollama()

    print("Starting ollama-chat server.js on port {} ...".format(APP_PORT))
    env = os.environ.copy()
    env["PORT"] = str(APP_PORT)
    env["OLLAMA_HOST"] = "http://127.0.0.1:{}".format(OLLAMA_PORT)
    main_log = open(SERVER_LOG, "w")
    main_proc = subprocess.Popen(
        [node_exe, "server.js"],
        cwd=os.getcwd(), env=env,
        creationflags=CREATE_NEW_PROCESS_GROUP,
        stdout=main_log, stderr=subprocess.STDOUT,
    )

    try:
        if not wait_for_port(APP_PORT, timeout=15):
            print("server.js never opened port {}".format(APP_PORT))
            sys.exit(1)
        token = read_app_token()
        session = requests.Session()
        session.headers["x-app-token"] = token
        base = "http://127.0.0.1:{}".format(APP_PORT)

        if IS_WIN:
            test_crlf_edit(session, base, project_root)
            test_cmdexe_quoting(session, base, project_root)
            test_stop_kills_child(session, base, project_root)
        test_sensitive_read_blocked(session, base, project_root)
        test_steer_non_string(session, base, project_root)
        test_db_durability(session, base)
    finally:
        with contextlib.suppress(Exception):
            main_proc.terminate()
            main_proc.wait(timeout=10)
        with contextlib.suppress(Exception):
            main_log.close()
    test_no_db_save_errors_in_log()

    # Runs its own separate server instance — needs a clean CTRL_BREAK target.
    if IS_WIN:
        test_ctrlbreak_kills_child(node_exe, os.path.join(os.getcwd(), "server.js"))

    print("\n=== Summary ===")
    n_ok = sum(1 for _, ok, _ in RESULTS if ok)
    for name, ok, _ in RESULTS:
        print(("PASS " if ok else "FAIL ") + name)
    print("{}/{} passed".format(n_ok, len(RESULTS)))
    sys.exit(0 if n_ok == len(RESULTS) else 1)


if __name__ == "__main__":
    main()