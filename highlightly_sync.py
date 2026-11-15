#!/usr/bin/env python3
"""Highlightly sync for the Championship, League One and League Two.

Reads finished matches, adds each player's stats to season totals and keeps their
last 8 match lines, then writes data/players.json for the website.
Safe to run every day: matches already added are skipped, it stops before the daily
request allowance runs out, and it picks up where it left off next time.
Uses only the Python standard library. Never prints the API key.
"""
import json, os, pathlib, re, sys, time, urllib.error, urllib.parse, urllib.request

BASE = "https://soccer.highlightly.net"
KEY = os.environ.get("HIGHLIGHTLY_API_KEY", "").strip()
SEASON = int(os.environ.get("SEASON", "2026"))
RESERVE = 4  # requests to leave unused each day
LEAGUES = {"Championship": 34824, "League One": 35675, "League Two": 36526}
OUT = pathlib.Path("data/players.json")
left = [None]


def get(path, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"x-rapidapi-key": KEY, "Accept": "application/json", "User-Agent": "efl-sync"})
    time.sleep(1.2)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            v = r.headers.get("x-ratelimit-requests-remaining")
            if v is not None and str(v).isdigit():
                left[0] = int(v)
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:200]
    except Exception as e:
        return 0, str(e)


def out_of_requests(extra=0):
    return left[0] is not None and left[0] <= RESERVE + extra


def num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str) and re.fullmatch(r"-?\d+(\.\d+)?", v.strip()):
        return float(v)
    return None


def pick(d, exact=(), contains=(), avoid=()):
    low = {str(k).lower(): k for k in d}
    for e in exact:
        if e in low and num(d[low[e]]) is not None:
            return num(d[low[e]])
    for k in low:
        if any(c in k for c in contains) and not any(a in k for a in avoid) and num(d[low[k]]) is not None:
            return num(d[low[k]])
    return None


STAT_WORDS = ("tackle", "passeskey", "goalsscored", "shotsontarget", "cardsyellow", "assists", "goalssaved", "duels", "interception", "clearance")


def is_stat_dict(d):
    keys = " ".join(str(k).lower() for k in d)
    return sum(1 for w in STAT_WORDS if w in keys) >= 3


def collect(node, stack, found):
    if isinstance(node, dict):
        stack.append(node)
        if is_stat_dict(node):
            found.append(list(stack))
        else:
            for v in node.values():
                collect(v, stack, found)
        stack.pop()
    elif isinstance(node, list):
        for v in node:
            collect(v, stack, found)


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def side_of(stack, m):
    hid, aid = str(m["home"].get("id")), str(m["away"].get("id"))
    hn, an = norm(m["home"].get("name")), norm(m["away"].get("name"))
    for a in reversed(stack):
        t = a.get("team") if isinstance(a.get("team"), dict) else {}
        for cid, cn in ((a.get("teamId"), a.get("teamName")), (t.get("id"), t.get("name")), (a.get("id"), a.get("name"))):
            if cid is not None and str(cid) == hid or cn and norm(cn) == hn:
                return "h"
            if cid is not None and str(cid) == aid or cn and norm(cn) == an:
                return "a"
    return None


def extract(data, m):
    """Turn a box-score or statistics response into one row per player."""
    found, rows = [], []
    collect(data, [], found)
    for stack in found:
        st = stack[-1]
        pl = next((d for d in reversed(stack) if isinstance(d.get("name") or d.get("fullName"), str)), None)
        if pl is None:
            continue
        name = pl.get("name") or pl.get("fullName")
        pos = next((str(pl[k]) for k in ("position", "positionName", "pos", "positionShort") if isinstance(pl.get(k), str)), "")
        mins = pick(st, ("minutesplayed", "minutes"), ("minute",), ("per", "90")) 
        if mins is None:
            mins = pick(pl, ("minutesplayed", "minutes"), ("minute",), ("per", "90"))
        side = side_of(stack[:-1] if pl is st else stack, m)
        row = {
            "pid": str(pl.get("id")) if pl.get("id") is not None else None,
            "n": name.strip(), "side": side, "pos": pos, "m": mins,
            "g": pick(st, ("goalsscored", "goals")), "a": pick(st, ("assists", "goalassists")),
            "sot": pick(st, ("shotsontarget",)), "kp": pick(st, ("passeskey", "keypasses")),
            "tk": pick(st, ("tacklestotal", "tackles"), ("tackle",), ("won", "lost", "success", "accuracy", "percent")),
            "int": pick(st, ("interceptions", "interceptionstotal"), ("intercept",)),
            "blk": pick(st, ("blocks", "blockstotal", "blockedshots"), ("block",), ("shotsblocked", "blockedby", "accuracy")),
            "clr": pick(st, ("clearances", "clearancestotal"), ("clearance",), ("accuracy", "success")),
            "sv": pick(st, ("goalssaved", "saves", "savestotal")),
            "yc": pick(st, ("cardsyellow", "yellowcards")), "rc": pick(st, ("cardsred", "redcards")),
            "pm": pick(st, ("penaltiesmissed",)),
        }
        rows.append(row)
    return rows


def key_of(r, team):
    return r["pid"] or (norm(r["n"]) + "|" + norm(team))


def add_match(players, m, rows):
    hg, ag = m["gh"], m["ga"]
    added = 0
    for r in rows:
        if r["side"] is None:
            continue
        mins = r["m"]
        active = (mins or 0) > 0 or any((r[k] or 0) > 0 for k in ("g", "a", "sot", "kp", "tk", "int", "blk", "clr", "sv"))
        if not active:
            continue
        team = m["home"]["name"] if r["side"] == "h" else m["away"]["name"]
        conceded = ag if r["side"] == "h" else hg
        p = players.setdefault(key_of(r, team), {"id": key_of(r, team), "n": r["n"], "t": team, "pos": "", "apps": 0, "m": 0, "g": 0, "a": 0,
                                                 "sot": 0, "kp": 0, "tk": 0, "int": 0, "blk": None, "clr": None, "sv": 0, "yc": 0, "rc": 0, "last": []})
        p["apps"] += 1
        p["m"] += mins or 0
        for k in ("g", "a", "sot", "kp", "tk", "int", "sv", "yc", "rc"):
            p[k] += r[k] or 0
        for k in ("blk", "clr"):
            if r[k] is not None:
                p[k] = (p[k] or 0) + r[k]
        line = [m["date"][:10], int(mins or 0), int(r["g"] or 0), int(r["a"] or 0), int(r["sv"] or 0), int(r["yc"] or 0), int(r["rc"] or 0), int(r["pm"] or 0), conceded]
        p["last"] = sorted(p["last"] + [line])[-8:]
        if r["pos"]:
            p["pos"] = r["pos"]
        if m["date"][:10] >= (p["last"][-1][0] if p["last"] else ""):
            p["t"] = team
        added += 1
    return added


def outline(o, depth=0, maxd=5):
    pad = "  " * depth
    if isinstance(o, dict):
        if depth >= maxd:
            return pad + "{...}\n"
        s = ""
        for k, v in list(o.items())[:14]:
            s += pad + str(k) + (": " + type(v).__name__ + "\n" if not isinstance(v, (dict, list)) else ":\n" + outline(v, depth + 1, maxd))
        return s
    if isinstance(o, list):
        return pad + "[list of %d]\n" % len(o) + (outline(o[0], depth + 1, maxd) if o else "")
    return pad + type(o).__name__ + "\n"


def list_finished():
    out = []
    for league, lid in LEAGUES.items():
        off = 0
        while True:
            st, d = get("/matches", {"leagueId": lid, "season": SEASON, "limit": 100, "offset": off})
            if st != 200 or not isinstance(d, dict):
                print("  %s listing stopped at offset %d (HTTP %s)" % (league, off, st))
                break
            for x in d.get("data", []):
                try:
                    if (x.get("state") or {}).get("description") != "Finished":
                        continue
                    sc = str((x.get("state") or {}).get("score", {}).get("current", "")).split("-")
                    out.append({"id": str(x["id"]), "date": x["date"], "league": league, "home": x["homeTeam"], "away": x["awayTeam"],
                                "gh": int(sc[0]), "ga": int(sc[1])})
                except (KeyError, ValueError, IndexError, TypeError):
                    continue
            total = (d.get("pagination") or {}).get("totalCount", 0)
            off += 100
            if off >= total or out_of_requests():
                break
        if out_of_requests():
            break
    return out


def main():
    if not KEY:
        print("No HIGHLIGHTLY_API_KEY found.")
        return 1
    store = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    done, skipped = set(store.get("done", [])), set(store.get("skipped", []))
    players = {p["id"]: p for p in store.get("players", [])}
    print("Already added: %d matches, %d players." % (len(done), len(players)))
    finished = list_finished()
    print("Finished matches listed: %d. Requests left: %s" % (len(finished), left[0]))
    todo = sorted([m for m in finished if m["id"] not in done and m["id"] not in skipped], key=lambda m: m["date"])
    print("Still to add: %d" % len(todo))
    use_stats, probed, diag_rows = store.get("use_stats"), 0, []
    for m in todo:
        if out_of_requests(1 if use_stats else 0):
            print("Stopping to keep the daily allowance. Run again tomorrow.")
            break
        st, box = get("/box-score/%s" % m["id"])
        if st != 200:
            print("  box-score %s -> HTTP %s" % (m["id"], str(st)))
            if st in (429, 0):
                break
            skipped.add(m["id"])
            continue
        rows = extract(box, m)
        if not done and probed < 1:
            print("\n--- STRUCTURE OF THE FIRST BOX-SCORE ---\n" + outline(box)[:2500])
        if use_stats is None and probed < 2 and not out_of_requests(1):
            s2, stats = get("/statistics/%s" % m["id"])
            probed += 1
            if s2 == 200:
                srows = extract(stats, m)
                print("  statistics probe: %d player-like rows, blocks %s, clearances %s" % (len(srows), sum(1 for r in srows if r["blk"] is not None), sum(1 for r in srows if r["clr"] is not None)))
                if probed == 1:
                    print("--- STRUCTURE OF THE FIRST STATISTICS RESPONSE ---\n" + outline(stats)[:1500])
                if any(r["blk"] is not None or r["clr"] is not None for r in srows):
                    use_stats = True
            if probed == 2 and use_stats is None:
                use_stats = False
        if use_stats:
            s2, stats = get("/statistics/%s" % m["id"])
            if s2 == 200:
                idx = {(r["pid"] or norm(r["n"])): r for r in rows}
                for r in extract(stats, m):
                    base = idx.get(r["pid"] or norm(r["n"]))
                    if base:
                        for k in ("blk", "clr", "int", "tk", "kp", "sot"):
                            if base[k] is None and r[k] is not None:
                                base[k] = r[k]
        if len(diag_rows) < 3:
            ok_team = sum(1 for r in rows if r["side"]) / max(1, len(rows))
            ok_min = sum(1 for r in rows if r["m"] is not None) / max(1, len(rows))
            diag_rows.append((len(rows), ok_team, ok_min))
            print("  check: %d players parsed, team found for %d%%, minutes for %d%%" % (len(rows), ok_team * 100, ok_min * 100))
            if len(diag_rows) == 3 and not done and (sum(d[0] for d in diag_rows) < 30 or min(d[1] for d in diag_rows) < .8 or min(d[2] for d in diag_rows) < .5):
                print("\nPARSE PROBLEM: nothing written. Copy this whole log to Claude so the reader can be adjusted.\n" + outline(box)[:3000])
                return 2
        if add_match(players, m, rows):
            done.add(m["id"])
        else:
            skipped.add(m["id"])
    cov = sum(1 for p in players.values() if p["blk"] is not None) / max(1, len(players))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        "updated": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()), "season": SEASON, "source": "highlightly.net",
        "matches_total": len(finished), "matches_done": len(done), "use_stats": use_stats, "blocks_clearances_share": round(cov, 2),
        "done": sorted(done), "skipped": sorted(skipped), "players": sorted(players.values(), key=lambda p: (p["t"], p["n"]))},
        separators=(",", ":")), encoding="utf-8")
    print("Wrote %d players. Matches added %d of %d. Blocks/clearances available for %d%% of players. Requests left: %s" % (len(players), len(done), len(finished), cov * 100, left[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
