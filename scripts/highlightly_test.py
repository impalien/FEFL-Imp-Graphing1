#!/usr/bin/env python3
"""Highlightly coverage test for the three EFL divisions.

Checks which of the stats the site needs actually appear in Highlightly's data
for recent matches. Prints a report to the Actions log. It never prints your key.
Uses roughly 25-35 requests (the free plan allows about 100 a day).
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://soccer.highlightly.net"
KEY = os.environ.get("HIGHLIGHTLY_API_KEY", "").strip()
SEASON = int(os.environ.get("SEASON", "2026"))
WANT = {
    "minutes played": ["minute"],
    "goals": ["goal"],
    "assists": ["assist"],
    "shots on target": ["shotsontarget", "shots_on_target", "shotontarget", "shots on target", "ontarget", "on_target"],
    "key passes": ["keypass", "key_pass", "key passes", "chancescreated", "chances created"],
    "tackles": ["tackle"],
    "interceptions": ["intercept"],
    "blocks": ["block"],
    "clearances": ["clearance"],
    "saves": ["save"],
    "clean sheets": ["cleansheet", "clean_sheet", "clean sheet"],
}
LEAGUES = {"Championship": ["championship"], "League One": ["league one", "league 1"], "League Two": ["league two", "league 2"]}
left = [None]


def get(path, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"x-rapidapi-key": KEY, "Accept": "application/json", "User-Agent": "coverage-test"})
    time.sleep(1.2)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            left[0] = r.headers.get("x-ratelimit-requests-remaining", left[0])
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300]
    except Exception as e:
        return 0, str(e)


def names(o, out=None, depth=0):
    """Every key name and every short text value found in the data (lower case)."""
    out = set() if out is None else out
    if isinstance(o, dict):
        for k, v in o.items():
            out.add(str(k).lower())
            names(v, out, depth + 1)
    elif isinstance(o, list):
        for v in o[:80]:
            names(v, out, depth + 1)
    elif isinstance(o, str) and len(o) < 40:
        out.add(o.lower())
    return out


def stat_dicts(o, found=None):
    """First few dicts that look like a player's stat line."""
    found = [] if found is None else found
    if len(found) >= 2:
        return found
    if isinstance(o, dict):
        keys = " ".join(str(k).lower() for k in o)
        hits = sum(1 for words in WANT.values() if any(w in keys for w in words))
        if hits >= 2 and not any(isinstance(v, (dict, list)) and v for v in o.values()):
            found.append(o)
        for v in o.values():
            stat_dicts(v, found)
    elif isinstance(o, list):
        for v in o[:60]:
            stat_dicts(v, found)
    return found


def present(data):
    ns = names(data)
    return {s for s, words in WANT.items() if any(w in n for n in ns for w in words)}


def when(m):
    for k in ("date", "startTime", "kickoff", "kickOff", "time", "utcDate"):
        v = m.get(k)
        if isinstance(v, str) and len(v) >= 10:
            try:
                t = datetime.fromisoformat(v.replace("Z", "+00:00"))
                return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
            except ValueError:
                pass
    return None


def unwrap(d):
    return d.get("data", d) if isinstance(d, dict) else d


def main():
    if not KEY:
        print("No HIGHLIGHTLY_API_KEY found. Add it as a repository secret first.")
        return 1
    print("=== 1. Finding the English leagues (season %d) ===" % SEASON)
    leagues, offset, tier = [], 0, None
    while offset < 400:
        st, d = get("/leagues", {"countryCode": "GB-ENG", "season": SEASON, "limit": 100, "offset": offset})
        if st != 200:
            print("Leagues request failed: HTTP %s %s" % (st, d))
            break
        tier = (d.get("plan") or {}).get("tier") if isinstance(d, dict) else tier
        page = unwrap(d)
        leagues += page if isinstance(page, list) else []
        total = (d.get("pagination") or {}).get("totalCount", 0) if isinstance(d, dict) else 0
        offset += 100
        if offset >= total:
            break
    print("Plan tier reported:", tier, "| English leagues returned:", len(leagues))
    chosen = {}
    for label, words in LEAGUES.items():
        c = [l for l in leagues if any(w in str(l.get("name", "")).lower() for w in words)]
        for l in c:
            print("  %s -> id %s, name %r" % (label, l.get("id"), l.get("name")))
        if c:
            chosen[label] = c[0]
        else:
            print("  %s -> NOT FOUND on this plan" % label)
    if not chosen:
        print("None of the three divisions came back. The free plan may hide them. Quota left:", left[0])
        return 0
    summary = {}
    now = datetime.now(timezone.utc)
    for label, lg in chosen.items():
        print("\n=== 2. %s (id %s) ===" % (label, lg.get("id")))
        played, shown = [], False
        for back in range(1, 13):
            day = (now - timedelta(days=back)).date().isoformat()
            st, d = get("/matches", {"leagueId": lg.get("id"), "date": day, "limit": 100})
            items = [m for m in (unwrap(d) if st == 200 else []) if isinstance(m, dict) and m.get("id")]
            if items and not shown:
                print("  SAMPLE MATCH (%s):" % day, json.dumps(items[0])[:500])
                shown = True
            played += [m for m in items if (when(m) or now) < now - timedelta(hours=3)]
            print("  %s: %d matches" % (day, len(items)))
            if len(played) >= 2:
                break
        print("Finished matches found: %d" % len(played))
        if not played:
            summary[label] = None
            continue
        seen = {}
        for n, m in enumerate(played[:2]):
            for ep in ("box-score", "lineups") + (("statistics",) if n == 0 else ()):
                st, d = get("/%s/%s" % (ep, m["id"]))
                if st != 200:
                    print("  /%s/%s -> HTTP %s %s" % (ep, m["id"], st, str(d)[:120]))
                    continue
                got = present(d)
                for s_ in got:
                    seen.setdefault(s_, set()).add(ep)
                print("  /%s/%s -> found: %s" % (ep, m["id"], ", ".join(sorted(got)) or "nothing"))
                if ep == "box-score":
                    for sd in stat_dicts(d)[:1]:
                        print("  SAMPLE PLAYER LINE:", json.dumps(sd)[:600])
        summary[label] = seen
    print("\n=== 3. SUMMARY: which stats Highlightly returns ===")
    for label, seen in summary.items():
        print("\n%s:" % label)
        if seen is None:
            print("  no finished matches to test")
            continue
        for s in WANT:
            print("  %-16s %s" % (s, ("yes (" + ", ".join(sorted(seen[s])) + ")") if s in seen else "MISSING"))
    print("\nRequests left today:", left[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
