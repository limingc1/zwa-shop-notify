"""凭据与实验历史存储（阶段 0 版）：本地 JSON 文件。

- 明文存本地，仅供个人阶段 0 验证；正式版的加密/上云策略按规划执行。
- 路径固定在本项目目录 data/ 下，git 应忽略。
"""

from __future__ import annotations

import json
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CREDS_PATH = DATA_DIR / "creds.json"
HISTORY_PATH = DATA_DIR / "history.jsonl"
WATCH_PATH = DATA_DIR / "watch.json"
NOTIFIED_PATH = DATA_DIR / "notified.json"


def load_watch() -> list[str]:
    """关注皮肤名列表。"""
    if not WATCH_PATH.exists():
        return []
    try:
        data = json.loads(WATCH_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def notified_this_cycle(end_ts: int) -> bool:
    """本期商店（以 end_ts 为唯一周期标识）是否已推送过（规划 7.2 去重）。"""
    if not end_ts or not NOTIFIED_PATH.exists():
        return False
    try:
        return str(end_ts) in json.loads(NOTIFIED_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False


def mark_notified(end_ts: int) -> None:
    """记录本期已推送。只保留最近若干条，避免无限增长。"""
    DATA_DIR.mkdir(exist_ok=True)
    seen: list[str] = []
    if NOTIFIED_PATH.exists():
        try:
            seen = json.loads(NOTIFIED_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            seen = []
    key = str(end_ts)
    if key and key not in seen:
        seen.append(key)
    seen = seen[-30:]  # 留最近 30 期足够
    NOTIFIED_PATH.write_text(json.dumps(seen), encoding="utf-8")


def save_creds(mval: dict, qq: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    CREDS_PATH.write_text(
        json.dumps({"mval": mval, "qq": qq, "saved_at": time.time()}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_creds() -> dict | None:
    if not CREDS_PATH.exists():
        return None
    try:
        return json.loads(CREDS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def append_history(event: dict) -> None:
    """实验历史：一行一条 JSON。阶段 0 用它记录
    登录/商店查询/静默重兑的时间与结果，攒出「会话真实寿命」的数据。"""
    DATA_DIR.mkdir(exist_ok=True)
    event = dict(event)
    event.setdefault("ts", time.time())
    event.setdefault("at", time.strftime("%Y-%m-%d %H:%M:%S"))
    with HISTORY_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
