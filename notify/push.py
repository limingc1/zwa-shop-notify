"""微信推送：Server酱 Turbo。未配 SendKey 时进入干跑模式（打印不外发）。

规划 3.0 第 2 条：推送通道与掌瓦登录态是两套独立凭据——商店查询挂了，
本模块仍应能把"续期提醒/故障告警"送达。因此 send() 不依赖任何 mval 凭据。
"""

from __future__ import annotations

import os

import httpx

SENDKEY = os.environ.get("SENDKEY", "").strip()
PUSH_URL = "https://sctapi.ftqq.com/{key}.send"


def is_dry_run() -> bool:
    return not SENDKEY


async def send(title: str, desp: str) -> dict:
    """发送一条微信推送。返回 {ok, channel, detail}。

    注意：ok=True 只代表 Server酱受理，不代表用户已读（规划 7.2）。
    """
    if is_dry_run():
        return {"ok": True, "channel": "dry-run", "detail": "（未配 SENDKEY，仅本地打印）",
                "title": title, "desp": desp}

    async with httpx.AsyncClient(timeout=20) as client:
        try:
            r = await client.post(
                PUSH_URL.format(key=SENDKEY),
                data={"title": title[:64], "desp": desp},
            )
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            return {"ok": False, "channel": "serverchan", "detail": f"推送请求失败：{e}"}

    # Server酱：code==0 为成功
    code = data.get("code", data.get("message"))
    ok = str(code) in ("0", "success", "OK")
    return {"ok": ok, "channel": "serverchan",
            "detail": str(data.get("message") or data)[:200]}
