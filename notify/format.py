"""把掌瓦商店区块整理成微信通知文本。

原则（规划六）：价格/名称以商店接口返回为准，不推测、不换算；
缺失字段留空即可，绝不编造。关注皮肤用 ⭐ 前置高亮。
"""

from __future__ import annotations

import time


def _fmt_price(raw) -> str:
    # rmb_price 实为 VP 数（ valo-stat 注释确认）；接口给什么显示什么
    s = str(raw or "").strip()
    return f"{s} VP" if s.isdigit() else s


def format_shop(blocks: list[dict], watch: set[str]) -> tuple[str, str]:
    """返回 (标题, 正文)。watch 为关注皮肤名集合（大小写/空格已在上层归一）。"""
    now = time.strftime("%m-%d %H:%M")
    title = f"掌瓦每日商店 · {time.strftime('%m-%d')}"
    lines: list[str] = [f"抓取时间 {now}", ""]
    hit_count = 0

    for blk in blocks if isinstance(blocks, list) else []:
        if not isinstance(blk, dict):
            continue
        key = blk.get("key") or ""
        # 王国商店周更，只在每日商店命中时才附带，避免刷屏
        items = blk.get("list") or []
        if key == "kingdomstore":
            # 王国商店本期信息收进一行摘要，不逐条展开（可按需改）
            names = "、".join(str((it or {}).get("goods_name", "")) for it in items if isinstance(it, dict))
            lines.append(f"〔{blk.get('title') or '王国商店'}〕{names}")
            continue

        end_ts = blk.get("end_ts") or 0
        end_txt = time.strftime("%m-%d %H:%M", time.localtime(end_ts)) if end_ts else "未知"
        lines.append(f"〔{blk.get('title') or '每日商店'}〕本期至 {end_txt}")
        for it in items:
            if not isinstance(it, dict):
                continue
            name = str(it.get("goods_name", "未知"))
            price = _fmt_price(it.get("rmb_price"))
            like = str(it.get("like_num", "")).strip()
            star = ""
            if _norm(name) in watch:
                star = "⭐ "
                hit_count += 1
            tail = f" · {like}" if like else ""
            lines.append(f"{star}{name}  {price}{tail}")
            # 商品图（接口自带的 512px 图，Markdown 嵌入，点开消息详情可见）
            pic = str(it.get("goods_pic") or "").strip()
            if pic.startswith("http"):
                lines.append(f"![{name}]({pic})")
            lines.append("")
        lines.append("")

    if hit_count:
        title = f"⭐ 关注皮肤出现在商店（{hit_count}）"
        lines.insert(1, f"⚠️ 命中 {hit_count} 件关注皮肤！")

    return title, "\n".join(lines).strip()


def format_alert(message: str) -> tuple[str, str]:
    """故障/续期提醒（走独立于商店的推送通道，规划 3.0 第 2 条）。"""
    return "掌瓦商店通知·提醒", message


def _norm(name: str) -> str:
    return (name or "").replace(" ", "").strip().lower()
