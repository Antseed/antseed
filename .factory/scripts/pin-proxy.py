#!/usr/bin/env python3
"""Pin audit: a streaming pass-through in front of the AntSeed buyer that logs, per request, which
factory step sent it, the pin header, the requested model, and the peer and service that answered.

Usage: pin-proxy.py <listen-port> <log.jsonl> [upstream=http://127.0.0.1:8377]
The factory points ANTHROPIC_BASE_URL at it (FACTORY_AUDIT_URL, default http://127.0.0.1:18377). The x-factory-step
header is stripped before forwarding; everything else goes through unchanged.
"""
import http.client, http.server, json, sys, threading, time, urllib.parse

port, log_path = int(sys.argv[1]), sys.argv[2]
up = urllib.parse.urlparse(sys.argv[3] if len(sys.argv) > 3 else "http://127.0.0.1:8377")
lock = threading.Lock()
HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "accept-encoding", "x-factory-step"}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _proxy(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        step = self.headers.get("x-factory-step", "")
        try:
            model = json.loads(body or b"{}").get("model", "")
        except Exception:
            model = ""
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        started = time.time()
        conn = http.client.HTTPConnection(up.hostname, up.port or 80, timeout=1800)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
        except Exception as error:
            self.send_error(502, f"pin-proxy upstream error: {error}")
            self._log(step, model, 502, None, None, started)
            return
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            conn.close()
        self._log(step, model, resp.status, resp.getheader("x-antseed-peer-id"), resp.getheader("x-antseed-service"), started)

    def _log(self, step, model, status, peer, service, started):
        entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "step": step, "path": self.path, "pin": self.headers.get("x-antseed-pin-peer"),
                 "source": self.headers.get("x-antseed-system-proxy-source"), "model": model, "status": status, "peer": peer,
                 "service": service, "ms": int((time.time() - started) * 1000)}
        with lock, open(log_path, "a") as out:
            out.write(json.dumps(entry) + "\n")

    do_POST = do_GET = do_PUT = do_DELETE = _proxy


http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
