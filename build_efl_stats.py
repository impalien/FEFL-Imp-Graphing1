#!/usr/bin/env python3
"""Build data/efl_stats.json (Championship, League One, League Two) for the FEFL web app.

Sources, all through soccerdata: FBref for players, results and fixtures; FotMob for team xG
when FBref has none. FBref removed its Opta "advanced" columns (xG, xA, key passes, blocks,
tackles, shots on target...) in Jan 2026, so those come back empty unless FBref restores them.
Every metric that cannot be worked out is written as null, never a crash and never a fake 0.
Env: EFL_SEASON (e.g. 2026-2027), EFL_OUT, EFL_NO_FOTMOB=1 to skip the slow FotMob step.
"""
import difflib, json, os, re, sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

OUT = Path(os.environ.get("EFL_OUT", "data/efl_stats.json"))
DIVS = {"ENG-Championship": "Championship", "ENG-League One": "League One", "ENG-League Two": "League Two"}
APP = {  # exact club names used by the web app
    "Championship": ["Birmingham City", "Blackburn Rovers", "Bolton Wanderers", "Bristol City", "Burnley", "Cardiff City", "Charlton Athletic", "Derby County", "Lincoln City", "Middlesbrough", "Millwall", "Norwich City", "Portsmouth", "Preston North End", "Queens Park Rangers", "Sheffield United", "Southampton", "Stoke City", "Swansea City", "Watford", "West Bromwich Albion", "West Ham United", "Wolverhampton Wanderers", "Wrexham"],
    "League One": ["AFC Wimbledon", "Barnsley", "Blackpool", "Bradford City", "Bromley", "Burton Albion", "Cambridge United", "Doncaster Rovers", "Huddersfield Town", "Leicester City", "Leyton Orient", "Luton Town", "Mansfield Town", "Milton Keynes Dons", "Notts County", "Oxford United", "Peterborough United", "Plymouth Argyle", "Reading", "Sheffield Wednesday", "Stevenage", "Stockport County", "Wigan Athletic", "Wycombe Wanderers"],
    "League Two": ["Accrington Stanley", "Barnet", "Bristol Rovers", "Cheltenham Town", "Chesterfield", "Colchester United", "Crawley Town", "Crewe Alexandra", "Exeter City", "Fleetwood Town", "Gillingham", "Grimsby Town", "Newport County", "Northampton Town", "Oldham Athletic", "Port Vale", "Rochdale", "Rotherham United", "Salford City", "Shrewsbury Town", "Swindon Town", "Tranmere Rovers", "Walsall", "York City"],
}
ALL_TEAMS = [t for v in APP.values() for t in v]
ALIAS = {"QPR": "Queens Park Rangers", "West Brom": "West Bromwich Albion", "Wolves": "Wolverhampton Wanderers",
         "MK Dons": "Milton Keynes Dons", "Sheffield Utd": "Sheffield United", "Sheffield Weds": "Sheffield Wednesday",
         "Sheffield Wed": "Sheffield Wednesday", "Preston": "Preston North End", "West Ham": "West Ham United",
         "Wycombe": "Wycombe Wanderers", "Stockport": "Stockport County", "Oxford Utd": "Oxford United",
         "Cambridge Utd": "Cambridge United", "Newport": "Newport County", "Wimbledon": "AFC Wimbledon"}
KEYS = ["team", "player"]
SPEC = {  # output column -> candidate FBref column names (first match wins = the season total)
    "standard": {"pos": ["Pos"], "mp": ["MP"], "min": ["Min"], "gls": ["Gls"], "ast": ["Ast"], "xag": ["xAG"]},
    "keepers": {"k_mp": ["MP"], "k_min": ["Min"], "ga": ["GA"], "saves": ["Saves"], "save_pct": ["Save%"], "cs": ["CS"], "sota": ["SoTA"]},
    "shooting": {"sot": ["SoT"]},
    "passing": {"kp": ["KP"], "xa": ["xA"]},
    "defense": {"tkl": ["Tkl"], "blk": ["Blocks"], "int": ["Int"], "clr": ["Clr"]},
}
NAN = float("nan")


# ---------- small safe helpers ----------
def nn(x):
    """float or None (NaN/None/bad -> None)."""
    try:
        return None if x is None or pd.isna(x) else float(x)
    except (TypeError, ValueError):
        return None


def sdiv(a, b, nd=1, mult=1):
    """a / b * mult, or None when either is missing or b is 0 (no ZeroDivisionError ever)."""
    a, b = nn(a), nn(b)
    return None if a is None or b is None or b == 0 else round(a / b * mult, nd)


def tot(*v):
    """Sum of the values that exist; None if none of them exist."""
    v = [x for x in map(nn, v) if x is not None]
    return round(sum(v), 2) if v else None


def app_name(raw):
    if raw is None or pd.isna(raw):
        return None
    s = ALIAS.get(str(raw).strip(), str(raw).strip())
    if s in ALL_TEAMS:
        return s
    m = difflib.get_close_matches(s, ALL_TEAMS, n=1, cutoff=0.6)
    return m[0] if m else s


def grp(pos):
    return {"GK": "GK", "DF": "DEF", "MF": "MID", "FW": "FWD"}.get(str(pos or "").upper().split(",")[0].strip())


def flat(raw):
    """soccerdata frame (MultiIndex index and columns) -> plain frame, first duplicate column wins."""
    d = raw.reset_index()
    names = []
    for c in d.columns:
        if isinstance(c, tuple):
            n = str(c[-1])
            c = str(c[0]) if (not n or n.startswith("Unnamed")) else n
        names.append(str(c))
    d.columns = names
    return d.loc[:, ~pd.Index(d.columns).duplicated()]


def pull(raw, spec):
    d = flat(raw)
    out = d[KEYS].copy()
    low = {}
    for c in d.columns:
        low.setdefault(c.lower(), c)
    for name, cands in spec.items():
        c = next((low[x.lower()] for x in cands if x.lower() in low), None)
        if c is None:
            out[name] = None if name == "pos" else NAN
        elif name == "pos":
            out[name] = d[c].astype(str)
        else:
            out[name] = pd.to_numeric(d[c].astype(str).str.replace(",", ""), errors="coerce")
    return out


# ---------- players ----------
def build_players(div, frames):
    df = None
    for f in frames:
        f = f.copy()
        f["team"] = f["team"].map(app_name)
        f = f.drop_duplicates(KEYS)
        df = f if df is None else df.merge(f, on=KEYS, how="outer")
    res = {"goalkeepers": [], "defenders": [], "midfielders": [], "attackers": []}
    if df is None:
        return res
    for spec in SPEC.values():
        for c in spec:
            if c not in df.columns:
                df[c] = None if c == "pos" else NAN
    for _, p in df.iterrows():
        pos = grp(p["pos"]) or ("GK" if nn(p["saves"]) is not None or nn(p["k_mp"]) is not None else None)
        if not pos:
            continue
        base = {"name": p["player"], "team": p["team"], "division": div, "pos": pos}
        if pos == "GK":
            mins = nn(p["k_min"]) if nn(p["k_min"]) is not None else nn(p["min"])
            if not mins:
                continue
            sv, ga = nn(p["saves"]), nn(p["ga"])
            pct = nn(p["save_pct"])
            if pct is None and sv is not None and nn(p["sota"]):
                pct = round(sv / p["sota"] * 100, 1)
            res["goalkeepers"].append({**base, "mp": nn(p["k_mp"]) if nn(p["k_mp"]) is not None else nn(p["mp"]),
                                       "minutes": mins, "saves": sv, "clean_sheets": nn(p["cs"]),
                                       "save_pct": pct, "goals_conceded": ga})
            continue
        mins = nn(p["min"])
        if not mins:
            continue
        g, a = nn(p["gls"]) or 0.0, nn(p["ast"]) or 0.0
        row = {**base, "mp": nn(p["mp"]), "minutes": mins, "goals": g, "assists": a,
               "min_per_goal_involvement": sdiv(mins, g + a)}
        if pos == "DEF":
            da = tot(p["blk"], p["clr"], p["tkl"])
            res["defenders"].append({**row, "blocks": nn(p["blk"]), "clearances": nn(p["clr"]), "tackles": nn(p["tkl"]),
                                     "defensive_actions": da, "min_per_defensive_action": sdiv(mins, da)})
        elif pos == "MID":
            ci = tot(p["kp"], p["int"])
            res["midfielders"].append({**row, "key_passes": nn(p["kp"]), "interceptions": nn(p["int"]),
                                       "chances_interceptions": ci, "min_per_chance_interception": sdiv(mins, ci)})
        else:
            xa = nn(p["xa"]) if nn(p["xa"]) is not None else nn(p["xag"])
            sot = nn(p["sot"])
            res["attackers"].append({**row, "shots_on_target": sot, "min_per_shot_on_target": sdiv(mins, sot),
                                     "xa": xa, "xa_per_90": sdiv(xa, mins, 3, 90)})
    for k in res:
        res[k].sort(key=lambda r: -(r["minutes"] or 0))
    return res


# ---------- teams ----------
def parse_matches(sched, div):
    out = []
    for _, r in flat(sched).iterrows():
        h, a = app_name(r.get("home_team")), app_name(r.get("away_team"))
        if not h or not a:
            continue
        m = re.search(r"(\d+)\s*[\u2013\-]\s*(\d+)", str(r.get("score", "")))
        d = pd.to_datetime(r.get("date"), errors="coerce")
        wk = pd.to_numeric(r.get("week"), errors="coerce")
        out.append({"div": div, "h": h, "a": a, "hg": int(m[1]) if m else None, "ag": int(m[2]) if m else None,
                    "hxg": nn(r.get("home_xg")), "axg": nn(r.get("away_xg")),
                    "date": None if pd.isna(d) else d.strftime("%Y-%m-%d"), "gw": None if pd.isna(wk) else int(wk)})
    return out


def build_teams(div, matches):
    T = {n: {"name": n, "division": div, "mp": 0, "w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0, "pts": 0,
             "xg": 0.0, "xga": 0.0, "xg_games": 0, "res": [], "fx": []} for n in APP[div]}
    for m in sorted((m for m in matches if m["div"] == div), key=lambda m: (m["date"] or "9999", m["gw"] or 0)):
        for me, op, gf, ga, xf, xa, ven in ((m["h"], m["a"], m["hg"], m["ag"], m["hxg"], m["axg"], "h"),
                                            (m["a"], m["h"], m["ag"], m["hg"], m["axg"], m["hxg"], "a")):
            t = T.get(me)
            if not t:
                continue
            if gf is None:
                t["fx"].append({"gw": m["gw"], "date": m["date"], "opp": op, "venue": ven})
                continue
            r = "W" if gf > ga else "D" if gf == ga else "L"
            t["mp"] += 1; t["gf"] += gf; t["ga"] += ga
            t[r.lower()] += 1; t["pts"] += {"W": 3, "D": 1, "L": 0}[r]; t["res"].append(r)
            if xf is not None and xa is not None:
                t["xg"] += xf; t["xga"] += xa; t["xg_games"] += 1
    return list(T.values())


def fotmob_xg(key, season):
    import soccerdata as sd
    d = sd.FotMob(leagues=key, seasons=season).read_team_match_stats(
        stat_type="Expected goals (xG)", opponent_stats=False).reset_index()
    col = next(c for c in d.columns if "expected goals" in str(c).lower())
    d[col] = pd.to_numeric(d[col], errors="coerce")
    d = d.dropna(subset=[col])
    d["_tot"] = d.groupby("game")[col].transform("sum")
    d["_cnt"] = d.groupby("game")[col].transform("count")
    d["_xga"] = (d["_tot"] - d[col]).where(d["_cnt"] == 2)
    d["team"] = d["team"].map(app_name)
    g = d.groupby("team").agg(xg=(col, "sum"), xga=("_xga", "sum"), n=(col, "count"))
    return {t: (float(r.xg), float(r.xga), int(r.n)) for t, r in g.iterrows()}


def finish_teams(rows):
    for t in rows:
        t["form"] = "".join(t.pop("res")[-5:])
        t["fixtures"] = t.pop("fx")[:8]
        n = t["xg_games"]
        t["xg_pg"], t["xga_pg"] = sdiv(t["xg"], n, 2), sdiv(t["xga"], n, 2)
        t["xg"], t["xga"] = (round(t["xg"], 2), round(t["xga"], 2)) if n else (None, None)
    for key, asc, out in (("xg_pg", False, "xg_rank"), ("xga_pg", True, "xga_rank")):
        ok = all(t[key] is not None for t in rows)  # rank only when all 24 clubs have data
        order = sorted(rows, key=lambda t: (t[key] if asc else -t[key]) if ok else 0)
        for i, t in enumerate(order, 1):
            t[out] = i if ok else None
    return rows


# ---------- main ----------
def get_season():
    if os.environ.get("EFL_SEASON"):
        return os.environ["EFL_SEASON"]
    n = datetime.now(timezone.utc)
    y = n.year if n.month >= 7 else n.year - 1
    return f"{y}-{y + 1}"


def setup():
    base = Path(os.environ.setdefault("SOCCERDATA_DIR", str(Path(".soccerdata").resolve())))
    (base / "config").mkdir(parents=True, exist_ok=True)
    cfg = {k: {"FBref": v, "FotMob": v, "season_start": "Aug", "season_end": "May"} for k, v in DIVS.items()}
    (base / "config" / "league_dict.json").write_text(json.dumps(cfg))


def main():
    setup()
    import soccerdata as sd  # imported after the league config exists
    season = get_season()
    meta = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "season": season,
            "sources": ["FBref via soccerdata"], "warnings": [], "unavailable_metrics": []}
    players = {"goalkeepers": [], "defenders": [], "midfielders": [], "attackers": []}
    teams = []
    for key, div in DIVS.items():
        try:
            fb = sd.FBref(leagues=key, seasons=season)
        except Exception as e:
            meta["warnings"].append(f"{div}: FBref setup failed: {e}")
            continue
        frames = []
        for stat, spec in SPEC.items():
            err = None
            for st in (("keepers", "keeper") if stat == "keepers" else (stat,)):
                try:
                    frames.append(pull(fb.read_player_season_stats(stat_type=st), spec))
                    err = None
                    break
                except Exception as e:
                    err = e
            if err:
                meta["warnings"].append(f"{div}: {stat} table failed: {str(err)[:150]}")
        for k, v in build_players(div, frames).items():
            players[k] += v
        matches = []
        try:
            matches = parse_matches(fb.read_schedule(), div)
        except Exception as e:
            meta["warnings"].append(f"{div}: schedule failed: {str(e)[:150]}")
        rows = build_teams(div, matches)
        if not any(t["xg_games"] for t in rows) and not os.environ.get("EFL_NO_FOTMOB"):
            try:
                fm = fotmob_xg(key, season)
                for t in rows:
                    if t["name"] in fm:
                        t["xg"], t["xga"], t["xg_games"] = fm[t["name"]]
                meta["sources"].append(f"FotMob via soccerdata ({div} xG)")
            except Exception as e:
                meta["warnings"].append(f"{div}: FotMob xG failed: {str(e)[:150]}")
        teams += finish_teams(rows)
    if not any(t["mp"] for t in teams) and not any(players.values()):
        sys.exit("No data came back from any source. Keeping the previous efl_stats.json untouched.")
    for k, rows in players.items():
        for f in (rows[0] if rows else {}):
            if f not in ("name", "team", "division", "pos") and all(r[f] is None for r in rows):
                meta["unavailable_metrics"].append(f"{k}.{f}")
    out = {"meta": meta, "teams": teams, **players}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
    print(f"Wrote {OUT}: {len(teams)} teams, " + ", ".join(f"{len(v)} {k}" for k, v in players.items()))
    for w in meta["warnings"]:
        print("WARNING:", w)


if __name__ == "__main__":
    main()
