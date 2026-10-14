"""
VForce RC Transmitter — Base Station Server.

Runs the PC base station, serves the Web UI (PC dashboard & mobile controller),
handles real-time input processing via RCController, broadcasts live channel state,
and optionally transmits channel data over UDP to RC receivers (ESP32/NodeMCU).
"""

import json
import socket
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from rc_controller import RCController
import uvicorn
import os
import sys
import threading
import signal
import webview
import datetime
import ipaddress

PLATFORM = sys.platform


def show_error_dialog(title: str, message: str):
    """Show a native error dialog — ctypes on Windows, tkinter on Linux."""
    if PLATFORM == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, message, title, 0x10)
    else:
        try:
            import tkinter as tk
            from tkinter import messagebox
            root = tk.Tk()
            root.withdraw()
            messagebox.showerror(title, message)
            root.destroy()
        except Exception:
            print(f"[ERROR] {title}: {message}", file=sys.stderr)


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0


# Fix for Uvicorn crashing when console=False in PyInstaller (sys.stdout is None)
if sys.stdout is None:
    class DummyStream:
        def write(self, *args, **kwargs): pass
        def flush(self, *args, **kwargs): pass
        def isatty(self): return False
    sys.stdout = DummyStream()
    sys.stderr = DummyStream()

# Base directory for resources
if hasattr(sys, '_MEIPASS'):
    BASE_DIR = sys._MEIPASS
    USER_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    USER_DIR = BASE_DIR

STATIC_DIR = os.path.join(BASE_DIR, "static")
PACKAGES_DIR = os.path.join(USER_DIR, "packages")
BG_DIR = os.path.join(PACKAGES_DIR, "Background")
MODELS_FILE = os.path.join(USER_DIR, "models.json")
OUTPUT_CONFIG_FILE = os.path.join(USER_DIR, "output_config.json")
SSL_CERT_FILE = os.path.join(USER_DIR, "vforce_cert.pem")
SSL_KEY_FILE = os.path.join(USER_DIR, "vforce_key.pem")


def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip


def generate_self_signed_cert():
    """Generate self-signed SSL cert valid for 10 years for HTTPS mobile access."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    local_ip = get_local_ip()
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, u"VForce RC Base"),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName(u"localhost"),
                x509.IPAddress(ipaddress.ip_address(local_ip)),
                x509.IPAddress(ipaddress.ip_address(u"127.0.0.1")),
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    with open(SSL_CERT_FILE, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(SSL_KEY_FILE, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    print("[VForce] SSL certificate generated.")


# ── Model & Output Storage ──────────────────────────────────────────

DEFAULT_OUTPUT_CONFIG = {
    "enabled": False,
    "target_ip": "192.168.4.1",
    "target_port": 8888,
    "protocol": "udp_raw_us",  # options: udp_raw_us, udp_json
    "rate_hz": 50
}


def load_models():
    if os.path.exists(MODELS_FILE):
        try:
            with open(MODELS_FILE, "r") as f:
                return json.load(f)
        except Exception as e:
            print(f"[ERROR] Failed to read {MODELS_FILE}: {e}")
    return {"active_model": "default_car", "models": {}}


def save_models(data):
    with open(MODELS_FILE, "w") as f:
        json.dump(data, f, indent=2)


def load_output_config():
    if os.path.exists(OUTPUT_CONFIG_FILE):
        try:
            with open(OUTPUT_CONFIG_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return dict(DEFAULT_OUTPUT_CONFIG)


def save_output_config(cfg):
    with open(OUTPUT_CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


models_data = load_models()
output_config = load_output_config()
rc_controller = RCController(models_data)

# UDP socket for sending channel values to ESP32 / Receiver
udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def transmit_udp(channels_us):
    """Optional UDP transmitter to send 16-channel microsecond pulses to receiver."""
    if not output_config.get("enabled", False):
        return
    try:
        target_ip = output_config.get("target_ip", "192.168.4.1")
        target_port = int(output_config.get("target_port", 8888))
        proto = output_config.get("protocol", "udp_raw_us")

        if proto == "udp_json":
            payload = json.dumps({"channels": channels_us}).encode("utf-8")
        else:
            # 16 channels as 16-bit big-endian unsigned integers (32 bytes)
            import struct
            payload = struct.pack(">" + "H" * 16, *channels_us[:16])

        udp_sock.sendto(payload, (target_ip, target_port))
    except Exception:
        pass


active_websockets = set()
_lifespan_started = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _lifespan_started
    if not _lifespan_started:
        _lifespan_started = True
        os.makedirs(STATIC_DIR, exist_ok=True)
        os.makedirs(BG_DIR, exist_ok=True)
        print("[VForce] RC Base Station initialized.")
        yield
    else:
        yield


app = FastAPI(lifespan=lifespan)

# Mount static files
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
if os.path.exists(PACKAGES_DIR):
    app.mount("/packages", StaticFiles(directory=PACKAGES_DIR), name="packages")


# ── Web Routes ────────────────────────────────────────────────────────

@app.get("/")
async def get_dashboard():
    """Serves the PC Base Station Dashboard directly."""
    pc_path = os.path.join(STATIC_DIR, "pc.html")
    if os.path.exists(pc_path):
        with open(pc_path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>static/pc.html not found.</h1>", status_code=404)


@app.get("/index.html")
async def get_index_redirect():
    return RedirectResponse(url="/")


@app.get("/Driving")
@app.get("/Flight")
async def redirect_legacy():
    return RedirectResponse(url="/")


@app.get("/mobile")
async def get_mobile():
    """Serves the Mobile RC Control interface."""
    mobile_path = os.path.join(STATIC_DIR, "mobile.html")
    if os.path.exists(mobile_path):
        with open(mobile_path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>static/mobile.html not found.</h1>", status_code=404)


# ── REST API Endpoints ───────────────────────────────────────────────

@app.get("/api/models")
async def get_models():
    return models_data


@app.post("/api/models")
async def update_models(request: Request):
    global models_data
    data = await request.json()
    models_data = data
    save_models(models_data)
    rc_controller.update_models(models_data)
    # Broadcast model update notification to connected mobile clients
    await broadcast_message({
        "type": "model_updated",
        "active_model": models_data.get("active_model", "")
    })
    return {"status": "success"}


@app.get("/api/channels")
async def get_channels():
    return {
        "channels": rc_controller.get_channels_dict(),
        "channels_us": rc_controller.get_channels_us()
    }


@app.get("/api/output")
async def get_output():
    return output_config


@app.post("/api/output")
async def update_output(request: Request):
    global output_config
    data = await request.json()
    output_config.update(data)
    save_output_config(output_config)
    return {"status": "success", "config": output_config}


@app.get("/api/network")
def get_network_info():
    return {
        "ip": get_local_ip(),
        "port": 8443,
        "http_port": 8000,
        "protocol": "https"
    }


@app.get("/api/packages")
def get_packages():
    def get_files(d):
        if not os.path.exists(d):
            return []
        return [f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f))]

    return {
        "background": get_files(BG_DIR)
    }


@app.post("/api/shutdown")
def shutdown_server():
    os.kill(os.getpid(), signal.SIGTERM)
    return {"status": "shutting down"}


# ── WebSocket Channel Streaming ──────────────────────────────────────

active_websockets = set()
dashboard_websockets = set()
last_broadcast_time = 0.0


async def broadcast_channels(channel_packet: str):
    """Broadcast channel state to connected PC dashboard monitors only."""
    for ws in list(dashboard_websockets):
        try:
            await asyncio.wait_for(ws.send_text(channel_packet), timeout=0.04)
        except Exception:
            dashboard_websockets.discard(ws)
            active_websockets.discard(ws)


async def broadcast_message(msg_dict):
    if not active_websockets:
        return
    payload = json.dumps(msg_dict)
    for ws in list(active_websockets):
        try:
            await asyncio.wait_for(ws.send_text(payload), timeout=0.1)
        except Exception:
            active_websockets.discard(ws)
            dashboard_websockets.discard(ws)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global last_broadcast_time
    await websocket.accept()
    active_websockets.add(websocket)

    try:
        # Send initial channel state and active model info upon connection
        await websocket.send_text(json.dumps({
            "type": "init",
            "channels": rc_controller.get_channels_dict(),
            "channels_us": rc_controller.get_channels_us(),
            "active_model": models_data.get("active_model", "")
        }))

        while True:
            data_str = await websocket.receive_text()
            try:
                data = json.loads(data_str)
                msg_type = data.get("type", "input")

                if msg_type == "input":
                    rc_controller.process_input(data)
                    channels_dict = rc_controller.get_channels_dict()
                    channels_us = rc_controller.get_channels_us()

                    # Transmit over UDP if enabled
                    transmit_udp(channels_us)

                    # Broadcast channels to dashboard monitors only, throttled to ~30Hz
                    now = asyncio.get_event_loop().time()
                    if now - last_broadcast_time >= 0.033:
                        last_broadcast_time = now
                        channel_packet = json.dumps({
                            "type": "channels",
                            "channels": channels_dict,
                            "channels_us": channels_us
                        })
                        asyncio.create_task(broadcast_channels(channel_packet))

                elif msg_type == "role":
                    if data.get("role") == "dashboard":
                        dashboard_websockets.add(websocket)

                elif msg_type == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))

            except json.JSONDecodeError:
                pass

    except (WebSocketDisconnect, Exception):
        pass
    finally:
        active_websockets.discard(websocket)
        dashboard_websockets.discard(websocket)
        if len(active_websockets) == 0:
            # If no active connections, revert to safe failsafe state
            rc_controller.apply_failsafe()
            transmit_udp(rc_controller.get_channels_us())


# ── Server Runners ───────────────────────────────────────────────────

def run_http_server(port):
    """Plain HTTP server bound to localhost only — for pywebview PC dashboard."""
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


def run_https_server(port, ssl_certfile, ssl_keyfile):
    """HTTPS server bound to 0.0.0.0 for phone browsers on LAN."""
    import selectors
    selector = selectors.SelectSelector()
    loop = asyncio.SelectorEventLoop(selector)
    asyncio.set_event_loop(loop)

    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=port,
        log_level="warning",
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
        loop="none",
    )
    server = uvicorn.Server(config)
    try:
        loop.run_until_complete(server.serve())
    finally:
        loop.close()


if __name__ == "__main__":
    http_port = 8000   # PC dashboard (localhost only)
    https_port = 8443  # Mobile phones (LAN, HTTPS)

    if is_port_in_use(http_port) or is_port_in_use(https_port):
        message = (
            "VForce is already running!\n\n"
            "Please open http://localhost:8000 in your browser or close the existing instance."
        )
        show_error_dialog("VForce RC", message)
        sys.exit(1)

    def cert_covers_current_ip():
        try:
            from cryptography import x509
            with open(SSL_CERT_FILE, "rb") as f:
                cert = x509.load_pem_x509_certificate(f.read())
            san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName)
            current_ip = ipaddress.ip_address(get_local_ip())
            return current_ip in san.value.get_values_for_type(x509.IPAddress)
        except Exception:
            return False

    if not os.path.exists(SSL_CERT_FILE) or not os.path.exists(SSL_KEY_FILE):
        print("[VForce] Generating self-signed SSL cert for mobile connection...")
        generate_self_signed_cert()
    elif not cert_covers_current_ip():
        print("[VForce] IP changed — regenerating SSL cert...")
        generate_self_signed_cert()

    local_ip = get_local_ip()
    print("\n" + "=" * 62)
    print("  VFORCE RC TRANSMITTER — BASE STATION RUNNING")
    print("=" * 62)
    print(f"  PC Dashboard : http://localhost:{http_port}/")
    print(f"  Phone Link   : https://{local_ip}:{https_port}/mobile")
    print("  Ready for RC control, channel mixing & monitoring.")
    print("=" * 62 + "\n")

    http_thread = threading.Thread(target=run_http_server, args=(http_port,), daemon=True)
    http_thread.start()

    https_thread = threading.Thread(
        target=run_https_server,
        args=(https_port, SSL_CERT_FILE, SSL_KEY_FILE),
        daemon=True
    )
    https_thread.start()

    gui_backend = None if PLATFORM == "win32" else "qt"
    webview.create_window(
        "VForce RC Base Station",
        f"http://localhost:{http_port}/",
        width=1280,
        height=840,
        min_size=(960, 680),
        maximized=True
    )
    webview.start(gui=gui_backend)
