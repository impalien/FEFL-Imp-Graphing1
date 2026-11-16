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
    best = {}  # the same player can appear twice in one response: keep the fuller row once
    for r in rows:
        k = (r["pid"] or norm(r["n"]), r["side"])
        score = sum(1 for kk in ("m", "g", "a", "sot", "kp", "tk", "int", "blk", "clr", "sv") if r[kk] is not None)
        if k not in best or score > best[k][0]:
            best[k] = (score, r)
    return [v[1] for v in best.values()]


def team_clearances(data, m):
    """Team-level clearances for one match: {'h': n, 'a': n}. Handles the common shapes."""
    res = {}

    def visit(node, stack):
        if isinstance(node, dict):
            stack.append(node)
            low = {str(k).lower(): v for k, v in node.items()}
            label = " ".join(str(v).lower() for v in node.values() if isinstance(v, str))
            if "clearance" in label and num(low.get("home")) is not None and num(low.get("away")) is not None:
                res.setdefault("h", num(low["home"]))
                res.setdefault("a", num(low["away"]))
            elif "clearance" in label:
                val = next((num(low[k]) for k in ("value", "count", "total") if num(low.get(k)) is not None), None)
                side = side_of(stack[:-1], m)
                if val is not None and side:
                    res.setdefault(side, val)
            for k, v in node.items():
                if "clearance" in str(k).lower() and num(v) is not None:
                    side = side_of(stack, m)
                    if side:
                        res.setdefault(side, num(v))
            for v in node.values():
                visit(v, stack)
            stack.pop()
        elif isinstance(node, list):
            for v in node:
                visit(v, stack)

    visit(data, [])
    return res


def key_of(r, team):
    return r["pid"] or (norm(r["n"]) + "|" + norm(team))


def add_match(players, m, rows):
    hg, ag = m["gh"], m["ga"]
    added = 0
    for r in rows:
        if r["side"] is None:
            continue
        mins = r["m"] if r["m"] is not None and 0 <= r["m"] <= 130 else None
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
    if store.get("complete") and os.environ.get("GITHUB_EVENT_NAME") == "schedule" and time.gmtime().tm_wday not in (0, 3):
        print("Everything is already added and today is not Monday or Thursday. Nothing to do, no requests used.")
        return 0
    done, skipped = set(store.get("done", [])), set(store.get("skipped", []))
    players = {p["id"]: p for p in store.get("players", [])}
    teams = store.get("teams", {})
    print("Already added: %d matches, %d players." % (len(done), len(players)))
    finished = list_finished()
    print("Finished matches listed: %d. Requests left: %s" % (len(finished), left[0]))
    # newest first, so the freshest form arrives first
    todo = sorted([m for m in finished if m["id"] not in done and m["id"] not in skipped], key=lambda m: m["date"], reverse=True)
    print("Still to add: %d" % len(todo))
    diag_rows, clr_found = [], 0

    def write():
        OUT.parent.mkdir(exist_ok=True)
        OUT.write_text(json.dumps({
            "updated": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()), "season": SEASON, "source": "highlightly.net",
            "matches_total": len(finished), "matches_done": len(done), "complete": len(done) + len(skipped) >= len(finished) > 0,
            "done": sorted(done), "skipped": sorted(skipped), "teams": teams,
            "players": sorted(players.values(), key=lambda p: (p["t"], p["n"]))}, separators=(",", ":")), encoding="utf-8")

    for m in todo:
        if out_of_requests(1):
            print("Stopping to keep the daily allowance. It carries on at the next run.")
            break
        st, box = get("/box-score/%s" % m["id"])
        if st != 200:
            print("  box-score %s -> HTTP %s" % (m["id"], str(st)))
            if st in (429, 0):
                break
            skipped.add(m["id"])
            continue
        rows = extract(box, m)
        if not done and not diag_rows:
            print("\n--- STRUCTURE OF THE FIRST BOX-SCORE ---\n" + outline(box)[:2500])
        s2, stats = get("/statistics/%s" % m["id"])
        tc = team_clearances(stats, m) if s2 == 200 else {}
        if tc and clr_found == 0 and not store.get("teams"):
            print("--- STRUCTURE OF THE FIRST STATISTICS RESPONSE ---\n" + outline(stats)[:1500])
        if len(diag_rows) < 3:
            ok_team = sum(1 for r in rows if r["side"]) / max(1, len(rows))
            ok_min = sum(1 for r in rows if r["m"] is not None) / max(1, len(rows))
            diag_rows.append((len(rows), ok_team, ok_min))
            print("  check: %d players parsed, team found for %d%%, minutes for %d%%, team clearances %s" % (len(rows), ok_team * 100, ok_min * 100, tc or "NOT FOUND"))
            if len(diag_rows) == 3 and not done and (sum(d[0] for d in diag_rows) < 30 or min(d[1] for d in diag_rows) < .8 or min(d[2] for d in diag_rows) < .5):
                print("\nPARSE PROBLEM: nothing written. Copy this whole log to Claude so the reader can be adjusted.\n" + outline(box)[:3000])
                return 2
        if add_match(players, m, rows):
            done.add(m["id"])
            for side, key in (("h", "home"), ("a", "away")):
                t = teams.setdefault(m[key]["name"], {"n": 0, "cn": 0, "clr": 0})
                t["n"] += 1
                if tc.get(side) is not None:
                    t["cn"] += 1
                    t["clr"] += tc[side]
                    clr_found += 1
        else:
            skipped.add(m["id"])
        if len(done) % 10 == 0:
            write()  # save progress as we go
    write()
    played = {}
    for m in finished:
        if m["id"] in done:
            for side in ("home", "away"):
                played[m[side]["name"]] = played.get(m[side]["name"], 0) + 1
    odd = [p for p in players.values() if p["apps"] > played.get(p["t"], 0) + 2]
    print("Check: %d players have more appearances than their club has matches added (should be 0)." % len(odd))
    for p in odd[:3]:
        print("  ODD: %s (%s) apps %d, club matches %d" % (p["n"], p["t"], p["apps"], played.get(p["t"], 0)))
    pos = {}
    for p in players.values():
        pos[p["pos"] or "(none)"] = pos.get(p["pos"] or "(none)", 0) + 1
    print("Positions in the feed:", dict(sorted(pos.items(), key=lambda kv: -kv[1])[:8]))
    withc = [(t, v["clr"] / v["cn"]) for t, v in teams.items() if v["cn"] >= 3]
    if withc:
        withc.sort(key=lambda x: x[1])
        print("Team clearances per match: lowest %s %.1f, highest %s %.1f (%d clubs)" % (withc[0][0], withc[0][1], withc[-1][0], withc[-1][1], len(withc)))
    else:
        print("Team clearances per match: none found yet")
    watch = os.environ.get("WATCH", "").strip().lower()
    for p in [p for p in players.values() if watch and watch in p["n"].lower()][:3]:
        print("WATCH %s (%s): apps %d, minutes %d, goals %d, assists %d, shots on target %d, key passes %d, tackles %d, interceptions %d" % (
            p["n"], p["t"], p["apps"], p["m"], p["g"], p["a"], p["sot"], p["kp"], p["tk"], p["int"]))
        print("  last matches [date, mins, goals, assists, saves, yellow, red, pen missed, club conceded]:", p["last"][-5:])
    print("Wrote %d players. Matches added %d of %d. Requests left: %s" % (len(players), len(done), len(finished), left[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
