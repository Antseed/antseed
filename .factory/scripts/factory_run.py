# Start the tdd-factory run and watch it until it ends. Runs inside Prime's ipython (the factory lead):
#
#     exec(open(".factory/scripts/factory_run.py").read()); print(await factory_go())
#
# factory_go() imports the machine, starts the run, and starts a background watcher in the same
# kernel. The watcher appends every run event to .factory/tasks/<slug>/events.jsonl and, when the run
# ends, fails or pauses, writes .factory/tasks/<slug>/outcome.md and sends a Herdr notification.
# A run Prime calls "done" counts as passed only if verify answered `VERIFY <slug> PASS`.
import asyncio as _asyncio
import json as _json
import re as _re
import time as _time
from pathlib import Path as _Path

def _factory_slug() -> str:
    text = _Path(".factory/current-task.md").read_text(encoding="utf-8")
    match = _re.search(r"^Factory slug:\s*(\S+)", text, _re.M)
    if not match:
        raise ValueError("no `Factory slug:` line in .factory/current-task.md")
    return match.group(1)


def _factory_outcome(slug: str, status: dict) -> tuple[str, str]:
    """(verdict, one-line reason) from a status() snapshot."""
    nodes = {node["id"]: node for node in status.get("nodes", [])}

    def answer(node_id: str) -> str:
        lines = (nodes.get(node_id, {}).get("answer_preview") or "").strip().splitlines()
        return lines[-1].strip() if lines else ""

    state = status.get("state")
    if state == "paused":
        return "PAUSED", f"run paused: {status.get('pause_reason') or 'unknown reason'}"
    if state == "stopped":
        return "STOPPED", "run was stopped"
    verify = answer("verify")
    if f"VERIFY {slug} PASS" in verify:
        return "PASS", verify
    for node_id in ("verify", "review", "build", "plan-check", "plan"):
        node = nodes.get(node_id, {})
        if node.get("error"):
            return "FAILED", f"{node_id} failed: {node['error']}"
        line = answer(node_id)
        if line:
            if node_id == "plan-check" and "PLAN_MISSING" in line:
                return "FAILED", f"plan never finished after {nodes.get('plan', {}).get('entries_used', '?')} tries: {line}"
            return "FAILED", f"stopped after {node_id}: {line}"
    return "FAILED", f"run {state} without any step answering"


async def _factory_notify(title: str, body: str, sound: str) -> None:
    try:
        process = await _asyncio.create_subprocess_exec(
            "herdr", "notification", "show", title, "--body", body, "--sound", sound,
            stdout=_asyncio.subprocess.DEVNULL, stderr=_asyncio.subprocess.DEVNULL,
        )
        await process.wait()
    except FileNotFoundError:
        pass


async def _factory_watch(run_id: str, slug: str) -> None:
    task_dir = _Path(".factory/tasks") / slug
    task_dir.mkdir(parents=True, exist_ok=True)
    events_file = task_dir / "events.jsonl"
    seen = 0
    paused_reported = None
    started = _time.time()
    while True:
        try:
            await rlm.factory.watch(run_id, 15)
            status = await rlm.factory.status(run_id)
        except Exception as error:  # the run vanished (kernel restart) or Prime refused
            await _factory_notify(f"factory: {slug} lost", f"watcher stopped: {error}", "request")
            return
        with events_file.open("a", encoding="utf-8") as out:
            for event in status.get("events", []):
                if event.get("seq", 0) > seen:
                    seen = event["seq"]
                    out.write(_json.dumps({"at": _time.strftime("%Y-%m-%dT%H:%M:%S"), **event}, ensure_ascii=False) + "\n")
        state = status.get("state")
        if state in ("running", "stopping"):
            paused_reported = None
            continue
        verdict, reason = _factory_outcome(slug, status)
        if state == "paused":
            if paused_reported != reason:
                paused_reported = reason
                await _factory_notify(f"factory: {slug} paused", f"{reason} | resume in the factory lead pane", "request")
            continue
        minutes = round((_time.time() - started) / 60)
        lines = [
            f"# {slug}: {verdict}",
            "",
            f"- reason: {reason}",
            f"- run: {run_id} ({state}, {minutes} min, {status.get('usage', {})})",
            "- steps: " + ", ".join(
                f"{node['id']} {node['status']} x{node.get('entries_used', 0)}" for node in status.get("nodes", [])
            ),
            f"- events: {events_file}",
        ]
        if verdict == "PASS":
            lines.append(f"- result: {task_dir / 'verify.md'}")
        (task_dir / "outcome.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        await _factory_notify(
            f"factory: {slug} {verdict}",
            f"{reason[:180]} | {(task_dir / 'outcome.md').resolve()}",
            "done" if verdict == "PASS" else "request",
        )
        return


async def factory_go(machine: str = "tdd-factory") -> str:
    from rlm.factory import import_machine

    slug = _factory_slug()
    import_machine(f".factory/machines/{machine}/MACHINE.md")
    started = await rlm.factory.run(machine, name=slug)
    run_id = started["run_id"]
    globals()["_factory_watcher"] = _asyncio.get_running_loop().create_task(_factory_watch(run_id, slug))
    return f"factory run {run_id} started for {slug}; watcher writes .factory/tasks/{slug}/events.jsonl and outcome.md and notifies you at the end"
