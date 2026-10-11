"""阶段 1 主流程：读凭据 → 查商店（过期自动静默重兑）→ 格式化 → 推送微信。

设计对齐规划：
- 3.0 报丧通道独立：商店查询失败时，仍用 push 发"续期/故障"提醒（不依赖 mval）。
- 2.2 分层续期：先静默重兑，成功则更新凭据并继续；失败才要求扫码。
- 7.2 去重：以 end_ts 为商店周期标识，同一周期默认只推一次（可 force 覆盖）。
"""

from __future__ import annotations

import time

from . import format as fmt
from . import push, storage
from .mval import MvalClient, MvalError
from .qq_login import LoginError, renew_with_qq_token


def _watch_set() -> set[str]:
    raw = storage.load_watch()
    return {fmt._norm(x) for x in raw if x}


async def _query_store(client: MvalClient):
    """查商店。返回 (blocks, None) 或 (None, MvalError)。"""
    try:
        blocks = await client.get_store()
        return blocks, None
    except MvalError as e:
        return None, e


async def run_once(force: bool = False) -> dict:
    """执行一次完整闭环。返回结果摘要（供 CLI 打印 / 后续云端调用）。"""
    bundle = storage.load_creds()
    if not bundle:
        return {"ok": False, "stage": "creds", "msg": "无凭据，请先 login"}

    mval = bundle["mval"]
    blocks, err = await _query_store(MvalClient(mval))

    # 过期 → 尝试静默重兑（阶段0已验证机制成立）
    if err and err.auth_expired:
        storage.append_history({"event": "auto_renew_try", "reason": "auth_expired"})
        try:
            new_mval = await renew_with_qq_token(bundle.get("qq") or {})
        except LoginError as e:
            # 静默续命也失败 → 报丧：走独立推送通道要求扫码
            await _alert(f"掌瓦登录态已过期，且静默续期失败。\n请重新扫码授权。\n原因：{e}")
            storage.append_history({"event": "auto_renew", "ok": False, "msg": str(e)})
            return {"ok": False, "stage": "renew", "msg": f"续期失败需扫码：{e}"}
        # 重兑成功：更新凭据，重查
        storage.save_creds(new_mval, bundle.get("qq") or {})
        storage.append_history({"event": "auto_renew", "ok": True})
        blocks, err = await _query_store(MvalClient(new_mval))

    if err:
        # 非过期类错误（限流/结构变化/网络）也要报丧，不能静默
        await _alert(f"商店查询失败（code={err.code}）：{err}")
        storage.append_history({"event": "run", "ok": False, "code": err.code})
        return {"ok": False, "stage": "store", "msg": str(err)}

    # 去重：本期 end_ts 已推过且非 force → 跳过
    end_ts = _first_end_ts(blocks)
    if not force and end_ts and storage.notified_this_cycle(end_ts):
        return {"ok": True, "stage": "dedup", "msg": f"本期(end_ts={end_ts})已通知，跳过", "skipped": True}

    title, body = fmt.format_shop(blocks, _watch_set())
    result = await push.send(title, body)
    storage.append_history({"event": "run", "ok": result["ok"], "end_ts": end_ts,
                            "channel": result["channel"]})
    if result["ok"]:
        storage.mark_notified(end_ts)
    return {"ok": result["ok"], "stage": "push", "title": title, "body": body, "push": result}


def _first_end_ts(blocks) -> int:
    for blk in blocks if isinstance(blocks, list) else []:
        if isinstance(blk, dict) and (blk.get("key") == "dailystore") and blk.get("end_ts"):
            return int(blk["end_ts"])
    for blk in blocks if isinstance(blocks, list) else []:
        if isinstance(blk, dict) and blk.get("end_ts"):
            return int(blk["end_ts"])
    return 0


async def _alert(message: str) -> None:
    """故障/续期提醒走独立推送通道（规划 3.0 第 2 条）。"""
    title, body = fmt.format_alert(message)
    await push.send(title, body)
