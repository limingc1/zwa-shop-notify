"""掌瓦（app.mval.qq.com）API 客户端 —— 移植自 valo-stat/server/mval.py，
只保留本项目需要的部分：角色查询 + 每日商店。"""

from __future__ import annotations

import time

import httpx

API_BASE = "https://app.mval.qq.com"

UA = (
    "Mozilla/5.0 (Linux; Android 12; 23117RK66C Build/V417IR; wv) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Version/4.0 Chrome/101.0.4951.61 Mobile Safari/537.36"
)

ROLE_PATH = "/go/account/get_main_role_raw"
STORE_PATH = "/go/mlol_store/agame/user_store"

# 登录态失效错误码：只有这两个（1003 是参数/瞬时错误，不能当过期）
AUTH_ERROR_CODES = {1001, 999999}


class MvalError(Exception):
    def __init__(self, message: str, code: int = -1, auth_expired: bool = False):
        super().__init__(message)
        self.code = code
        self.auth_expired = auth_expired


class MvalClient:
    def __init__(self, creds: dict):
        self.creds = creds or {}

    def _cookie(self, variant: str = "real_token") -> str:
        c = self.creds
        token = c.get("access_token", "") or "null"
        parts = [
            "clientType=9",
            f"uin=o{c.get('uin', 0)}",
            "appid=102061775",
            "acctype=qc",
            f"openid={c.get('openid', '')}",
        ]
        if variant == "real_token":
            parts.append(f"access_token={token}")
        elif variant == "scene":
            parts.append(f"access_token={token}")
            parts.append(f"scene={token}")
        else:
            parts.append("access_token=null")
        parts.extend(
            [
                f"userId={c.get('userId', '')}",
                "accountType=5",
                f"tid={c.get('tid', '')}",
            ]
        )
        return "; ".join(parts)

    def _headers(self, variant: str = "real_token") -> dict[str, str]:
        return {
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Connection": "keep-alive",
            "Cookie": self._cookie(variant),
        }

    async def _post_once(self, path: str, body: dict | None, timeout: float, variant: str):
        url = f"{API_BASE}{path}"
        payload = body if body is not None else {"_t": int(time.time())}
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
                resp = await client.post(url, headers=self._headers(variant), json=payload)
                data = resp.json()
        except httpx.HTTPError as e:
            raise MvalError(f"网络错误：{e}") from e
        except ValueError as e:
            raise MvalError("响应不是合法 JSON") from e

        code = data.get("result", -1)
        if code != 0:
            msg = data.get("errMsg") or data.get("msg") or f"错误码 {code}"
            raise MvalError(str(msg), code=code, auth_expired=code in AUTH_ERROR_CODES)
        return data.get("data")

    async def post(
        self,
        path: str,
        body: dict | None = None,
        timeout: float = 25,
        variants: tuple[str, ...] = ("real_token", "default", "scene"),
    ):
        """依次尝试 Cookie 形态；只有「登录态失效」才换下一个重试。"""
        last: MvalError | None = None
        for variant in variants:
            try:
                return await self._post_once(path, body, timeout, variant)
            except MvalError as e:
                last = e
                if not e.auth_expired:
                    raise
        assert last is not None
        raise last

    async def get_role(self) -> dict:
        data = await self.post(ROLE_PATH)
        roles = (data or {}).get("list") or []
        if not roles:
            raise MvalError("未找到游戏角色，请确认该 QQ 已绑定无畏契约角色")
        return roles[0]

    async def get_store(self) -> list[dict]:
        """每日商店轮换。返回区块列表（dailystore 每日商店 / kingdomstore 王国商店）。"""
        return await self.post(STORE_PATH)
