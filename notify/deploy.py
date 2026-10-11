"""云端部署辅助脚本（本地运行）。

用法：
    python -m notify.deploy keypair        # 生成 AES-256 密钥(base64)与触发令牌，打印后填进 .env
    python -m notify.deploy creds <url>    # 把本地 data/creds.json 加密导入 Worker（走 HTTPS+Bearer）
    python -m notify.deploy watch <url>    # 把本地 data/watch.json 导入 Worker
    python -m notify.deploy run <url>      # 手动触发一次云端闭环（测试用）
    python -m notify.deploy status <url>   # 查看云端最近运行记录

<url> 形如 https://zwa-shop-notify.<你的子域>.workers.dev
"""

from __future__ import annotations

import json
import secrets
import sys
from pathlib import Path

import httpx

from . import storage

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def _env_get(name: str) -> str:
    if not ENV_PATH.exists():
        return ""
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    return ""


def cmd_keypair() -> None:
    key = secrets.token_bytes(32)
    import base64
    print(f"CRED_KEY={base64.b64encode(key).decode()}")
    print(f"TRIGGER_TOKEN={secrets.token_urlsafe(24)}")
    print("→ 把这两行追加到 .env，并用 wrangler secret put 同步到云端（见部署说明）")


def _post(url: str, path: str, payload) -> str:
    token = _env_get("TRIGGER_TOKEN")
    if not token:
        print("缺少 TRIGGER_TOKEN，先运行：python -m notify.deploy keypair 并写入 .env")
        sys.exit(1)
    r = httpx.post(
        f"{url.rstrip('/')}{path}",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.text


def cmd_creds(url: str) -> None:
    bundle = storage.load_creds()
    if not bundle:
        print("本地没有凭据（data/creds.json），先 login")
        sys.exit(1)
    # 只传 Worker 需要的字段，避免多余信息出境
    payload = {
        "mval": {k: bundle["mval"].get(k) for k in ("userId", "tid", "openid", "uin", "access_token")},
        "qq": {k: (bundle.get("qq") or {}).get(k) for k in ("openid", "access_token")},
    }
    print(_post(url, "/put-creds", payload))


def cmd_watch(url: str) -> None:
    names = storage.load_watch()
    print(_post(url, "/put-watch", names))


def cmd_run(url: str) -> None:
    token = _env_get("TRIGGER_TOKEN")
    r = httpx.post(
        f"{url.rstrip('/')}/run",
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    r.raise_for_status()
    print(r.text)


def cmd_status(url: str) -> None:
    token = _env_get("TRIGGER_TOKEN")
    r = httpx.get(f"{url.rstrip('/')}/status", headers={"Authorization": f"Bearer {token}"}, timeout=30)
    data = r.json()
    print("有凭据：" + ("是" if data.get("has_creds") else "否"))
    for e in data.get("history", []):
        print(f"  {e['ts']}  {e['event']:<14} ok={e['ok']}  {e.get('detail') or ''}")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    arg = sys.argv[2] if len(sys.argv) > 2 else ""
    if cmd == "keypair":
        cmd_keypair()
    elif cmd in ("creds", "watch", "run", "status"):
        if not arg.startswith("http"):
            print(__doc__)
            sys.exit(1)
        {"creds": cmd_creds, "watch": cmd_watch, "run": cmd_run, "status": cmd_status}[cmd](arg)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
