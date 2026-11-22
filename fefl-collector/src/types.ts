// Shapes of the three public Fantasy EFL files, as seen on 2026-11 (trimmed to what we use).
export type Pos = 'GK' | 'DEF' | 'MID' | 'FWD';
export const POSITIONS: Pos[] = ['GK', 'DEF', 'MID', 'FWD'];

/** The cumulative season counters Fantasy EFL publishes per player. */
export const STAT_KEYS = ['appearances', 'goalsScored', 'assists', 'keyPasses', 'shotsOnTarget', 'cleanSheets', 'clearances', 'blocks', 'tackles', 'interceptions', 'saves'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type StatLine = Record<StatKey, number>;

export interface RawPlayer extends StatLine {
  id: number; squadId: number; competitionId: number; firstName: string; lastName: string; displayName: string;
  position: Pos; status: string; totalPoints: number; averagePoints: number; roundPoints: number | null;
  lastThree: { roundId: number; points: number }[]; percentSelected: number;
  suspensionDetails: null | { type?: string; startDate?: string; endDate?: string | null; matches?: number; description?: string };
  injuryDetails: null | { type?: string; startDate?: string; endDate?: string | null; expectedEndDate?: string | null; status?: string };
}
export interface RawSquad {
  id: number; competitionId: number; name: string; shortName: string; abbreviation: string; totalPoints: number; averagePoints: number;
  roundPoints: number | null; lastThree: { roundId: number; points: number }[]; percentSelected: number; leaguePosition: number | null;
  fdrHome: number | null; fdrAway: number | null; last3Form: string[]; backgroundColor: string; textColor: string;
}
export interface RawEvent { playerId: number; side: 'Home' | 'Away'; type: string; minute: number; period: string; assistPlayerId: number | null }
export interface RawGame { id: number; competitionId: number; date: string; status: string; isFinalized: boolean; homeId: number; awayId: number; homeScore: number | null; awayScore: number | null; events: RawEvent[] }
export interface RawRound { id: number; roundNumber: number; name: string; status: string; lockoutDate: string; completedAt: string | null; avgPoints: number | null; games: RawGame[] }
