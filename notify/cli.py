"""阶段 0 命令行工具。

用法（在本项目目录下）：
    python -m notify.cli login    # 生成二维码 → 手机QQ扫码 → 存凭据 → 立即验证商店
    python -m notify.cli check    # 用已存凭据查一次商店（核对内容 + 记录会话存活）
    python -m notify.cli renew    # 实验：不扫码，用存储的 QQ token 静默重兑掌瓦 tid
    python -m notify.cli run      # 完整闭环：查商店→（过期自动续期）→推送微信
    python -m notify.cli run --force  # 同上，忽略"本期已推送"去重
    python -m notify.cli watch 皮肤名  # 添加关注皮肤（重复运行会覆盖列表需先删 data/watch.json）
    python -m notify.cli history  # 查看实验历史

login 会把二维码存为 data/qrcode.png，打开看/发到电脑上扫都行。
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

try:  # 可选：项目目录放 .env 时自动加载（SENDKEY 等）
    from pathlib import Path

    from dotenv import load_dotenv

    _env = Path(__file__).resolve().parent.parent / ".env"
    if _env.exists():
        load_dotenv(_env, override=False)
except ImportError:
    pass

from . import storage
from .mval import MvalClient, MvalError
from .qq_login import LoginError, QQScanSession, renew_with_qq_token


async def cmd_login() -> None:
    session = QQScanSession()
    print("正在获取二维码…")
    qr = await session.fetch_qr()
    out = storage.DATA_DIR / "qrcode.png"
    storage.DATA_DIR.mkdir(exist_ok=True)
    out.write_bytes(qr)
    print(f"二维码已保存：{out}")
    print("请用【手机 QQ】扫码（150 秒内有效），等待确认…")

    deadline = time.time() + 150
    last_msg = ""
    while time.time() < deadline:
        status, msg = await session.poll()
        if msg != last_msg:
            print(f"  [{time.strftime('%H:%M:%S')}] {msg}")
            last_msg = msg
        if status == "success":
            break
        if status == "expired":
            print("二维码过期，请重新运行 login")
            await session.aclose()
            return
        if status == "error":
            print(f"轮询出错：{msg}")
            await session.aclose()
            return
        await asyncio.sleep(2)
    else:
        print("等待超时，请重新运行 login")
        await session.aclose()
        return

    try:
        mval, qq = await session.finish()
    finally:
        await session.aclose()

    storage.save_creds(mval, qq)
    storage.append_history({"event": "login", "ok": True})
    print(f"\n登录成功：角色 userId={mval['userId'][:4]}***  tid 已保存")
    print(f"QQ token 有效期字段 expires_in = {qq.get('expires_in') or '（响应未提供）'}")
    print("凭据已存 data/creds.json —— 接着自动验证一次商店：\n")
    await cmd_check()


async def cmd_check() -> None:
    bundle = storage.load_creds()
    if not bundle:
        print("还没有凭据，先运行：python -m notify.cli login")
        return
    client = MvalClient(bundle["mval"])
    try:
        blocks = await client.get_store()
    except MvalError as e:
        storage.append_history({"event": "check", "ok": False, "code": e.code, "msg": str(e)})
        if e.auth_expired:
            print(f"❌ 登录态已失效（code={e.code}）——距上次登录约 "
                  f"{(time.time() - bundle.get('saved_at', 0)) / 86400:.1f} 天")
            print("   这正是阶段 0 要的寿命数据；现在可试 python -m notify.cli renew 验证静默续期")
        else:
            print(f"❌ 商店查询失败（code={e.code}）：{e}")
        return

    storage.append_history({"event": "check", "ok": True,
                            "days_since_login": round((time.time() - bundle.get("saved_at", 0)) / 86400, 2)})
    print("✅ 商店查询成功（请和掌瓦 App 里核对内容是否一致）：\n")
    for blk in blocks if isinstance(blocks, list) else []:
        if not isinstance(blk, dict):
            continue
        print(f"【{blk.get('title') or blk.get('key')}】 本期结束于 "
              f"{time.strftime('%m-%d %H:%M', time.localtime(blk.get('end_ts') or 0))}")
        for it in blk.get("list") or []:
            if not isinstance(it, dict):
                continue
            print(f"  · {it.get('goods_name', '未知'):<24} {it.get('rmb_price', '')}  "
                  f"{it.get('quality', '')}  {it.get('like_num', '')}")
        print()


async def cmd_renew() -> None:
    bundle = storage.load_creds()
    if not bundle:
        print("还没有凭据，先运行：python -m notify.cli login")
        return
    qq = bundle.get("qq") or {}
    print(f"存储的 QQ token：expires_in={qq.get('expires_in') or '未提供'}，"
          f"记录于 {time.strftime('%m-%d %H:%M', time.localtime(qq.get('recorded_at', 0)))}")
    print("实验：不扫码，直接用 QQ token 重兑掌瓦 tid…")
    try:
        new_mval = await renew_with_qq_token(qq)
    except LoginError as e:
        storage.append_history({"event": "renew", "ok": False, "msg": str(e)})
        print(f"❌ 静默重兑失败：{e}")
        print("   → 结论：过期后只能回到扫码（规划 3.2 第 7 条的手机闭环就是为此准备的）")
        return
    storage.append_history({"event": "renew", "ok": True, "new_tid_head": new_mval["tid"][:6]})
    print("✅ 静默重兑成功！新的掌瓦凭据已拿到（未覆盖旧凭据，先验证再用）")
    print("   下一步：手动把 data/creds.json 里 mval 换成上面的新凭据，或直接运行 check 看旧的是否仍可用")
    print("   （阶段 0 只需要这个成败结论；正式实现里由云端自动完成替换）")
    print(json.dumps({k: (v[:8] + '***' if isinstance(v, str) and len(v) > 12 else v)
                      for k, v in new_mval.items()}, ensure_ascii=False, indent=2))


def cmd_history() -> None:
    if not storage.HISTORY_PATH.exists():
        print("暂无历史记录")
        return
    for line in storage.HISTORY_PATH.read_text(encoding="utf-8").splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        print(f"{e.get('at')}  {e.get('event'):<6} ok={e.get('ok')} " +
              " ".join(f"{k}={v}" for k, v in e.items() if k not in ('event', 'ok', 'at', 'ts')))


def cmd_watch(names: list[str]) -> None:
    """设置关注皮肤列表（整体覆盖写入 data/watch.json）。"""
    storage.DATA_DIR.mkdir(exist_ok=True)
    storage.WATCH_PATH.write_text(json.dumps(names, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"关注列表已保存（{len(names)} 项）：{names}")


async def cmd_run(force: bool = False) -> None:
    from . import run as runner, push

    mode = "（干跑模式：未配 SENDKEY，只打印不外发）" if push.is_dry_run() else ""
    print(f"执行一次完整闭环 {mode}\n")
    result = await runner.run_once(force=force)
    if result.get("skipped"):
        print(f"⏭ {result['msg']}（用 run --force 可强制重推）")
        return
    if result.get("body"):
        print(f"标题：{result['title']}\n正文：\n{result['body']}\n")
    if result["ok"]:
        p = result.get("push") or {}
        ch = p.get("channel", "?")
        print(f"✅ 闭环完成（推送通道 {ch}：{p.get('detail', '')}）")
    else:
        print(f"❌ 闭环未完成 stage={result['stage']}: {result['msg']}")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    args = sys.argv[2:]
    if cmd == "run":
        asyncio.run(cmd_run(force="--force" in args))
    elif cmd == "watch":
        cmd_watch(args)
    else:
        table = {"login": cmd_login, "check": cmd_check, "renew": cmd_renew}
        if cmd in table:
            try:
                asyncio.run(table[cmd]())
            except KeyboardInterrupt:
                pass
        elif cmd == "history":
            cmd_history()
        else:
            print(__doc__)


if __name__ == "__main__":
    main()
