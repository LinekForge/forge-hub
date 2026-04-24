#!/usr/bin/env python3
"""扫描 Claude Code 会话，输出格式（每行）：
unix_timestamp␞HH:MM␞first_msg␞session_id
分隔符 ␞ = \\x1e (Record Separator)
按 mtime 降序，供菜单栏 app 解析和分组。
"""
import json, os, glob, datetime, re

sessions = []
base = os.path.expanduser(os.path.join("~", ".claude", "projects"))
for f in glob.glob(os.path.join(base, "*", "*.jsonl")):
    try:
        sid = os.path.basename(f).replace(".jsonl", "")
        mtime = os.path.getmtime(f)
        size = os.path.getsize(f)

        if size < 500:
            continue

        first_msg = ""
        skip = False
        with open(f) as fh:
            for i, line in enumerate(fh):
                if i > 100:
                    break
                try:
                    d = json.loads(line)
                    if d.get("entrypoint") == "sdk-cli":
                        skip = True
                        break
                    if d.get("type") == "user" and not first_msg:
                        msg = d.get("message", {})
                        content = msg.get("content", "")
                        text = ""
                        if isinstance(content, list):
                            for p in content:
                                if isinstance(p, dict) and p.get("type") == "text":
                                    text = p["text"].strip()
                                    break
                        elif isinstance(content, str):
                            text = content.strip()
                        text = re.sub(r"^(/\S+\s+)+", "", text)
                        if text.startswith("<") or len(text) < 3:
                            continue
                        text = text.replace("\n", " ").replace("\r", " ")
                        first_msg = text[:50]
                except:
                    pass
        if skip:
            continue

        if not first_msg:
            first_msg = "..."

        sessions.append(
            {
                "sid": sid,
                "mtime": mtime,
                "time": datetime.datetime.fromtimestamp(mtime).strftime("%H:%M"),
                "first_msg": first_msg,
            }
        )
    except:
        pass

sessions.sort(key=lambda x: x["mtime"], reverse=True)
for s in sessions:
    # 格式：unix_timestamp␞HH:MM␞first_msg␞session_id（␞ = \x1e Record Separator）
    print(f'{int(s["mtime"])}\x1e{s["time"]}\x1e{s["first_msg"]}\x1e{s["sid"]}')
