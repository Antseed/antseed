#!/usr/bin/env python3
"""Discover, select, generate, and download Antseed videos without leaking media or secrets."""

from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_PROXY_URL = "http://127.0.0.1:8377"
AUTHORIZATION = "Bearer antseed-desktop"
MAX_FRAME_BYTES = 25 * 1024 * 1024
MAX_VIDEO_BYTES = 512 * 1024 * 1024
JSON_LIMIT = 1024 * 1024
AUTO_DURATIONS = {"auto", "Auto", "-1", "1 gen"}
INPUT_FIELDS = {
    "first_frame": "image_url",
    "last_frame": "end_image_url",
}


class VideoError(Exception):
    def __init__(self, message: str, code: str = "video_error", **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def emit(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


def fail(error: VideoError) -> int:
    emit({"ok": False, "error": {"code": error.code, "message": str(error), **error.details}})
    return 1


def proxy_url(raw: str) -> str:
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.username or parsed.password:
        raise VideoError("Proxy URL must be a loopback http URL.", "unsafe_proxy_url")
    return raw.rstrip("/")


def request_json(method: str, url: str, body: dict[str, Any] | None = None, headers: dict[str, str] | None = None, timeout: int = 120) -> tuple[int, dict[str, str], dict[str, Any]]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("authorization", AUTHORIZATION)
    if body is not None:
        request.add_header("content-type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(JSON_LIMIT + 1)
            return response.status, dict(response.headers), parse_json(raw)
    except urllib.error.HTTPError as error:
        raw = error.read(JSON_LIMIT + 1)
        return error.code, dict(error.headers), parse_json(raw)
    except urllib.error.URLError as error:
        raise VideoError("Could not reach the local Antseed buyer proxy.", "proxy_unreachable", reason=str(error.reason)) from error


def parse_json(raw: bytes) -> dict[str, Any]:
    if len(raw) > JSON_LIMIT:
        raise VideoError("Response was too large to inspect safely.", "response_too_large")
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def error_from(status: int, body: dict[str, Any], fallback: str) -> VideoError:
    error = body.get("error")
    if isinstance(error, dict):
        code = str(error.get("code") or error.get("type") or f"http_{status}")
        message = str(error.get("message") or fallback)
    else:
        code = f"http_{status}"
        message = str(error or body.get("message") or fallback)
    return VideoError(message, code, status=status)


def catalog(base: str) -> list[dict[str, Any]]:
    status, _, body = request_json("GET", f"{base}/v1/models?type=videos")
    if status != 200:
        raise error_from(status, body, "Could not list video models.")
    data = body.get("data")
    return [entry for entry in data if isinstance(entry, dict)] if isinstance(data, list) else []


def resolve_model(base: str, requested: str) -> dict[str, Any]:
    needle = requested.strip().lower()
    for entry in catalog(base):
        names = [entry.get("id"), *(entry.get("aliases") or [])]
        if any(isinstance(name, str) and name.lower() == needle for name in names):
            model_id = str(entry["id"])
            status, _, detail = request_json("GET", f"{base}/v1/models/{urllib.parse.quote(model_id, safe='')}")
            if status != 200:
                raise error_from(status, detail, "Could not inspect the video model.")
            return detail
    raise VideoError(f"Video model '{requested}' was not found.", "model_not_found")


def peer_options(peer: dict[str, Any]) -> dict[str, Any]:
    capabilities = peer.get("capabilities")
    video = capabilities.get("video") if isinstance(capabilities, dict) else None
    return video if isinstance(video, dict) else {}


def price_estimate(peer: dict[str, Any], duration: int | None, resolution: str | None) -> float | None:
    models = peer.get("unitBillingModels")
    model = models.get("venice-video") if isinstance(models, dict) else None
    components = model.get("components") if isinstance(model, dict) else None
    if not isinstance(components, list):
        return None
    total = 0.0
    for component in components:
        if not isinstance(component, dict):
            continue
        match = component.get("match")
        if isinstance(match, dict):
            if match.get("model") not in (None, peer.get("serviceId")):
                continue
            if match.get("resolution") not in (None, resolution):
                continue
        price = component.get("priceUsd")
        if not isinstance(price, (int, float)):
            continue
        if component.get("unit") == "video_generations":
            total += float(price)
        elif component.get("unit") == "video_seconds":
            if duration is None:
                return None
            total += float(price) * duration
    return round(total, 6)


def peer_summary(peer: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    return {
        "peerId": peer.get("peerId"),
        "displayName": peer.get("displayName"),
        "serviceId": peer.get("serviceId"),
        "reputationScore": peer.get("effectiveReputationScore", peer.get("reputationScore")),
        "estimatedPriceUsd": price_estimate(peer, getattr(args, "duration", None), getattr(args, "resolution", None)),
        "video": peer_options(peer),
    }


def requested_inputs(args: argparse.Namespace) -> list[str]:
    return [kind for kind, value in (("first_frame", args.first_frame), ("last_frame", args.last_frame)) if value]


def incompatibilities(peer: dict[str, Any], args: argparse.Namespace) -> list[str]:
    if "venice-video" not in (peer.get("protocols") or []):
        return ["venice-video protocol"]
    video = peer_options(peer)
    reasons: list[str] = []
    checks = [
        ("duration", args.duration, "durationsSeconds"),
        ("resolution", args.resolution, "resolutions"),
        ("aspect ratio", args.aspect_ratio, "aspectRatios"),
    ]
    for label, value, key in checks:
        allowed = video.get(key)
        if value is not None and isinstance(allowed, list) and value not in allowed:
            reasons.append(label)
    if args.audio is not None and video.get("audio") is not True:
        reasons.append("audio setting")
    inputs = requested_inputs(args)
    allowed_inputs = video.get("inputs")
    if isinstance(allowed_inputs, list):
        reasons.extend(kind for kind in inputs if kind not in allowed_inputs)
    required = video.get("requiredInputs")
    if isinstance(required, list):
        reasons.extend(f"missing {kind}" for kind in required if kind not in inputs)
    return reasons


def compatible_peers(model: dict[str, Any], args: argparse.Namespace) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    compatible: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for peer in model.get("peers") or []:
        if not isinstance(peer, dict) or not isinstance(peer.get("peerId"), str):
            continue
        reasons = incompatibilities(peer, args)
        (rejected if reasons else compatible).append({"peer": peer, "reasons": reasons})
    def score(item: dict[str, Any]) -> tuple[float, float]:
        peer = item["peer"]
        reputation = peer.get("effectiveReputationScore", peer.get("reputationScore"))
        price = price_estimate(peer, args.duration, args.resolution)
        reputation_value = float(reputation) if isinstance(reputation, (int, float)) else -1.0
        price_value = price if price is not None else float("inf")
        return (price_value, -reputation_value) if args.prefer == "price" else (-reputation_value, price_value)
    compatible.sort(key=score)
    return compatible, rejected


def alternatives(model: dict[str, Any]) -> dict[str, list[Any]]:
    result: dict[str, set[Any]] = {"durationsSeconds": set(), "resolutions": set(), "aspectRatios": set(), "inputs": set()}
    for peer in model.get("peers") or []:
        if not isinstance(peer, dict):
            continue
        video = peer_options(peer)
        for key in result:
            value = video.get(key)
            if isinstance(value, list):
                result[key].update(value)
    return {key: sorted(values, key=lambda value: (isinstance(value, str), value)) for key, values in result.items() if values}


def selected_peer(model: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    compatible, rejected = compatible_peers(model, args)
    if args.peer:
        wanted = args.peer.lower().removeprefix("0x")
        compatible = [item for item in compatible if item["peer"]["peerId"].lower().removeprefix("0x") == wanted]
    if not compatible:
        raise VideoError(
            "No advertised seller supports the requested video options.",
            "no_compatible_video_offer",
            alternatives=alternatives(model),
            rejected=[{"peerId": item["peer"].get("peerId"), "reasons": item["reasons"]} for item in rejected],
        )
    return compatible[0]["peer"]


def detect_image(raw: bytes) -> str | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def image_data_url(path: str) -> str:
    raw = Path(path).expanduser().read_bytes()
    if not raw or len(raw) > MAX_FRAME_BYTES:
        raise VideoError(f"{path} must be an image up to 25 MiB.", "invalid_frame")
    mime_type = detect_image(raw)
    if not mime_type:
        raise VideoError(f"{path} must be PNG, JPEG, or WebP.", "invalid_frame")
    return f"data:{mime_type};base64,{base64.b64encode(raw).decode()}"


def read_prompt(args: argparse.Namespace) -> str:
    prompt = Path(args.prompt_file).read_text() if args.prompt_file else args.prompt
    if not prompt or not prompt.strip():
        raise VideoError("A video prompt is required.", "missing_prompt")
    return prompt.strip()


def create_body(peer: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    service = peer.get("serviceId") or args.model_id
    body: dict[str, Any] = {"model": f"{peer['peerId']}@{service}", "prompt": read_prompt(args)}
    if args.duration is not None:
        body["duration"] = f"{args.duration}s"
    elif args.auto_duration:
        body["duration"] = "auto"
    if args.resolution:
        body["resolution"] = args.resolution
    if args.aspect_ratio:
        body["aspect_ratio"] = args.aspect_ratio
    if args.audio is not None:
        body["audio"] = args.audio
    if args.first_frame:
        body[INPUT_FIELDS["first_frame"]] = image_data_url(args.first_frame)
    if args.last_frame:
        body[INPUT_FIELDS["last_frame"]] = image_data_url(args.last_frame)
    return body


def is_unsafe_ip(value: str) -> bool:
    address = ipaddress.ip_address(value)
    return not address.is_global or address.is_multicast


def assert_safe_https(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or host == "localhost" or host.endswith(".localhost"):
        raise VideoError("Video service returned an unsafe download URL.", "unsafe_download_url")
    try:
        if is_unsafe_ip(host):
            raise VideoError("Video service returned an unsafe download URL.", "unsafe_download_url")
    except ValueError:
        pass
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)}
    except socket.gaierror as error:
        raise VideoError("Could not resolve the video download host.", "download_failed") from error
    if not addresses or any(is_unsafe_ip(address) for address in addresses):
        raise VideoError("Video service returned an unsafe download URL.", "unsafe_download_url")


def save_mp4(response: Any, output: Path) -> int:
    length = response.headers.get("content-length")
    if length and int(length) > MAX_VIDEO_BYTES:
        raise VideoError("Generated video exceeds the size limit.", "video_too_large")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".antseed-video-", suffix=".mp4", dir=output.parent)
    total = 0
    try:
        with os.fdopen(fd, "wb") as handle:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_VIDEO_BYTES:
                    raise VideoError("Generated video exceeds the size limit.", "video_too_large")
                handle.write(chunk)
        with open(temp_name, "rb") as handle:
            header = handle.read(12)
        if len(header) < 12 or header[4:8] != b"ftyp":
            raise VideoError("Video service returned an unsupported format.", "invalid_video")
        os.replace(temp_name, output)
        return total
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def retrieve_once(base: str, model_id: str, job_id: str, output: Path, download_url: str | None) -> dict[str, Any]:
    body = {"model": model_id, "queue_id": job_id, "delete_media_on_completion": False}
    request = urllib.request.Request(f"{base}/api/v1/video/retrieve", data=json.dumps(body).encode(), method="POST")
    request.add_header("authorization", AUTHORIZATION)
    request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            if response.headers.get_content_type() == "video/mp4":
                return {"state": "done", "bytes": save_mp4(response, output)}
            status_body = parse_json(response.read(JSON_LIMIT + 1))
    except urllib.error.HTTPError as error:
        raise error_from(error.code, parse_json(error.read(JSON_LIMIT + 1)), "Video status failed.") from error
    status = str(status_body.get("status", "")).upper()
    if status in {"FAILED", "CANCELLED"}:
        raise error_from(422, status_body, "Video generation failed.")
    if status == "COMPLETED":
        if not download_url:
            raise VideoError("Video completed without a download URL.", "missing_download_url")
        assert_safe_https(download_url)
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(download_url, timeout=300) as response:
            return {"state": "done", "bytes": save_mp4(response, output)}
    return {"state": status.lower() or "pending"}


def wait_for_video(base: str, model_id: str, job_id: str, output: Path, download_url: str | None, interval: int, timeout: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = retrieve_once(base, model_id, job_id, output, download_url)
        if result["state"] == "done":
            return result
        time.sleep(interval)
    raise VideoError("Timed out while waiting for the video.", "video_timeout", jobId=job_id)


def command_models(args: argparse.Namespace) -> dict[str, Any]:
    models = []
    for entry in catalog(args.proxy_url):
        models.append({"id": entry.get("id"), "name": entry.get("name"), "aliases": entry.get("aliases"), "sellers": len(entry.get("peers") or [])})
    return {"ok": True, "models": models}


def command_options(args: argparse.Namespace) -> dict[str, Any]:
    model = resolve_model(args.proxy_url, args.model)
    peers = [peer_summary(peer, args) for peer in model.get("peers") or [] if isinstance(peer, dict)]
    return {"ok": True, "model": model.get("id"), "sellers": peers, "alternatives": alternatives(model)}


def command_select(args: argparse.Namespace) -> dict[str, Any]:
    model = resolve_model(args.proxy_url, args.model)
    args.model_id = model.get("id")
    compatible, _ = compatible_peers(model, args)
    selected = selected_peer(model, args) if args.peer or not compatible else compatible[0]["peer"]
    return {"ok": True, "model": model.get("id"), "selected": peer_summary(selected, args), "compatible": [peer_summary(item["peer"], args) for item in compatible]}


def command_generate(args: argparse.Namespace) -> dict[str, Any]:
    if not args.peer:
        raise VideoError("Run select first and pass the confirmed seller with --peer.", "missing_peer")
    model = resolve_model(args.proxy_url, args.model)
    args.model_id = str(model.get("id"))
    peer = selected_peer(model, args)
    status, headers, accepted = request_json("POST", f"{args.proxy_url}/api/v1/video/queue", create_body(peer, args), timeout=300)
    if status < 200 or status >= 300:
        error = error_from(status, accepted, "Video creation failed.")
        error.details.update({"peerId": peer["peerId"]})
        raise error
    job_id = accepted.get("queue_id")
    if not isinstance(job_id, str) or not job_id:
        raise VideoError("Video service did not return a job id.", "missing_job_id", peerId=peer["peerId"])
    output = Path(args.output).expanduser().resolve()
    download_url = accepted.get("download_url") if isinstance(accepted.get("download_url"), str) else None
    try:
        result = wait_for_video(args.proxy_url, str(peer.get("serviceId") or args.model_id), job_id, output, download_url, args.poll_interval, args.timeout)
    except VideoError as error:
        error.details.update({"jobId": job_id, "peerId": peer["peerId"]})
        raise
    return {"ok": True, "output": str(output), "bytes": result["bytes"], "model": args.model_id, "peerId": headers.get("x-antseed-seller-peer") or peer["peerId"], "jobId": job_id}


def command_download(args: argparse.Namespace) -> dict[str, Any]:
    output = Path(args.output).expanduser().resolve()
    result = wait_for_video(args.proxy_url, args.model, args.job_id, output, None, args.poll_interval, args.timeout)
    return {"ok": True, "output": str(output), "bytes": result["bytes"], "model": args.model, "jobId": args.job_id}


def command_frame(args: argparse.Namespace) -> dict[str, Any]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise VideoError("ffmpeg is required to extract frames.", "ffmpeg_missing")
    source = Path(args.video).expanduser().resolve()
    if not source.is_file():
        raise VideoError(f"Video not found: {source}", "file_error")
    output = Path(args.output).expanduser().resolve()
    if output.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise VideoError("Frame output must end in .png, .jpg, .jpeg, or .webp.", "invalid_frame")
    output.parent.mkdir(parents=True, exist_ok=True)
    seek = ["-sseof", "-0.1"] if args.position == "last" else []
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *seek, "-i", str(source), "-frames:v", "1", "-update", "1", str(output)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode != 0 or not output.is_file() or output.stat().st_size == 0:
        raise VideoError("Could not extract a frame from the video.", "frame_extract_failed", stderr=result.stderr.strip()[-300:])
    return {"ok": True, "output": str(output), "position": args.position, "video": str(source)}


def add_request_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", required=True)
    parser.add_argument("--peer")
    parser.add_argument("--prefer", choices=("reputation", "price"), default="reputation")
    parser.add_argument("--duration", type=int)
    parser.add_argument("--auto-duration", action="store_true")
    parser.add_argument("--resolution")
    parser.add_argument("--aspect-ratio")
    audio = parser.add_mutually_exclusive_group()
    audio.add_argument("--audio", dest="audio", action="store_true", default=None)
    audio.add_argument("--no-audio", dest="audio", action="store_false")
    parser.add_argument("--first-frame")
    parser.add_argument("--last-frame")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--proxy-url", default=os.environ.get("ANTSEED_PROXY_URL", DEFAULT_PROXY_URL))
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("models")
    options = commands.add_parser("options")
    options.add_argument("--model", required=True)
    options.add_argument("--duration", type=int)
    options.add_argument("--resolution")
    select = commands.add_parser("select")
    add_request_options(select)
    generate = commands.add_parser("generate")
    add_request_options(generate)
    prompt = generate.add_mutually_exclusive_group(required=True)
    prompt.add_argument("--prompt")
    prompt.add_argument("--prompt-file")
    generate.add_argument("--output", default="generated-video.mp4")
    generate.add_argument("--poll-interval", type=int, default=5)
    generate.add_argument("--timeout", type=int, default=1800)
    frame = commands.add_parser("frame")
    frame.add_argument("--video", required=True)
    frame.add_argument("--position", choices=("first", "last"), default="last")
    frame.add_argument("--output", required=True)
    download = commands.add_parser("download")
    download.add_argument("--model", required=True)
    download.add_argument("--job-id", required=True)
    download.add_argument("--output", default="generated-video.mp4")
    download.add_argument("--poll-interval", type=int, default=5)
    download.add_argument("--timeout", type=int, default=1800)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        args.proxy_url = proxy_url(args.proxy_url)
        if getattr(args, "duration", None) is not None and args.duration <= 0:
            raise VideoError("Duration must be a positive integer.", "invalid_duration")
        if getattr(args, "auto_duration", False) and args.duration is not None:
            raise VideoError("Use either --duration or --auto-duration.", "invalid_duration")
        handlers = {"models": command_models, "options": command_options, "select": command_select, "generate": command_generate, "download": command_download, "frame": command_frame}
        emit(handlers[args.command](args))
        return 0
    except VideoError as error:
        return fail(error)
    except OSError as error:
        return fail(VideoError(str(error), "file_error"))


if __name__ == "__main__":
    sys.exit(main())
