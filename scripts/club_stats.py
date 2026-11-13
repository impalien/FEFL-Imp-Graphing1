#!/usr/bin/env python3
"""Weekly EFL club stats from football-data.co.uk (free CSV downloads).

For every Championship, League One and League Two club it works out:
  p   games played
  cs  clean sheets (conceded 0)
  g2  games where the club scored 2 or more goals
and writes data/clubs.json for the website to pick up.
Uses only the Python standard library.
"""
import csv, datetime, io, json, pathlib, sys, urllib.request

LEAGUES = {"E1": "Championship", "E2": "League One", "E3": "League Two"}
URL = "https://www.football-data.co.uk/mmz4281/{season}/{code}.csv"


def season_code(today=None):
    d = today or datetime.date.today()
    y = d.year if d.month >= 7 else d.year - 1
    return "%02d%02d" % (y % 100, (y + 1) % 100)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (weekly club stats job)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8-sig", errors="replace")


def compute(text, league):
    clubs = {}
    for r in csv.DictReader(io.StringIO(text)):
        home = (r.get("HomeTeam") or "").strip()
        away = (r.get("AwayTeam") or "").strip()
        try:
            hg, ag = int(r["FTHG"]), int(r["FTAG"])
        except (KeyError, TypeError, ValueError):
            continue  # unplayed match or blank row
        if not home or not away:
            continue
        for team, gf, ga in ((home, hg, ag), (away, ag, hg)):
            s = clubs.setdefault(team, {"club": team, "league": league, "p": 0, "cs": 0, "g2": 0})
            s["p"] += 1
            s["cs"] += 1 if ga == 0 else 0
            s["g2"] += 1 if gf >= 2 else 0
    return clubs


def main(argv):
    season = argv[1] if len(argv) > 1 else season_code()
    out, problems = [], []
    for code, league in LEAGUES.items():
        try:
            clubs = compute(fetch(URL.format(season=season, code=code)), league)
        except Exception as e:  # keep going, report at the end
            problems.append("%s: %s" % (code, e))
            continue
        out.extend(clubs.values())
        print("%s: %d clubs" % (league, len(clubs)))
    if len(out) < 60:
        print("Too few clubs found (%d). Not writing. Problems: %s" % (len(out), problems), file=sys.stderr)
        return 1
    out.sort(key=lambda c: (c["league"], c["club"]))
    path = pathlib.Path("data/clubs.json")
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps({
        "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "season": season, "source": "football-data.co.uk", "clubs": out}, indent=1), encoding="utf-8")
    print("Wrote %d clubs to %s" % (len(out), path))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
