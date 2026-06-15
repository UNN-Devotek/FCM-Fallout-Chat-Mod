/**
 * Pure, dependency-free helpers shared by the maintainer-run dev tooling
 * (`scripts/seed-dev.ts` and `scripts/clone-discord-layout.ts`).
 *
 * Everything in this module is deterministic and side-effect-free so it can be
 * unit-tested without a database or a Discord connection. All DB / network I/O
 * lives in the scripts; the logic that needs covering lives here.
 *
 * SR-004 (hosted-dev-environment.md): fake content is SYNTHESIZED. None of the
 * generators below sample, copy, or derive from real prod usernames or message
 * text — realism comes only from the static `SIM_NAMES` set + the templates
 * defined here.
 */

/**
 * 200 unique pre-composed names — realistic FO76 player tags. Kept in sync with
 * `src/routes/simUsers.ts` (the canonical sim-user source). Duplicated here so
 * the maintainer seed script has no runtime dependency on the express router.
 */
export const SIM_NAMES: readonly string[] = [
  'CrusaderBobby','NukaColaDrinker','TheWastelandKing','RaiderQueen76','AtomicMaiden',
  'BottleCapKing','VaultTechEngineer','GhoulWhisperer','SteelRainFalling','CranberryBogRunner',
  'AppalachiaOutlaw','NukaCherryBomb','RadSurfer','MirelurkSlayer','EnclaveSurvivor',
  'FissurePatrol','ScorchedEarther','UltraciteHunter','VulcanPilot','GleamingDepthsDiver',
  'TheRogueSentinel','AtomCatMechanic','WastelandWitch','SteelDawnKnight','BlueMountainHiker',
  'NukaBomber','ThePhosphorGlow','CranberryMoonshine','FoundationBuilder','TradingPostKing',
  'WhitespringButler','AppalachiaRanger','ScrappyOutlaw','CryptoVaultDweller','MeadowBandit',
  'RadstormChaser','NightOwlPatrol','TheGhoulFather','LegendaryHunter','SteelReign76',
  'CapCollectorPro','AtomFanatic','TinkerMechanic','DrifterOfTheWastes','VaultEscapee',
  'MoleMinerKing','EvictionNoticeSender','BloatflyRider','MirelurkQueen76','NukaWorldTourist',
  'PipboyNerd','PowerArmorPilot','FalloutVeteran','TheLastRaider','RadScorpWrangler',
  'ScorchBeastKiller','TheEnclaveSpy','BrotherhoodSquire','TreasureHunter76','SatchelSamurai',
  'WandaFromAppalachia','IronButterfly76','TheBottleCapBandit','StarcorePilot','NukaSlurper',
  'AcidicAvenger','SteelDriftwood','PhosphorKnight','TundraWalker','CryptoNomad',
  'RadiantRose76','GlitchInTheMatrix','AtomSmasher','LostInAppalachia','RadRoachRacer',
  'ToxicSludgeSwimmer','SteelMothmanHunter','CabinFeverJoe','MossyOvergrowth','BluegrassGunslinger',
  'VaultBoy76','HarbingerOfDoom','FrostbackRider','GhoulDetector','PixelOutlaw',
  'NukaQueenBee76','ScorchPatrol','AquaGirlGaming','WildWestWanderer','TinkerTomcat',
  'FoundationFighter','GrogNakPunch','PixelPatriotGaming','AquaticAssassin','TheSatchelRunner',
  'IronMaidenVault','ScorchBeastTamer','BlueMoonRaider','VaultTechVictor','MirelurkMauler',
  'CrimsonCapCollector','RadDaddy76','UltraGenetic','GlimmerGhoul','StarcrossedSurvivor',
  'TheNukaMachine','CranberryBandit','AppalachianMountaineer','SteelDawnPaladin','NukaCapTrader',
  'FrostmawHunter','TheAcidicAlf','WastelandDoctor','GrognaKTheBrave','AtomCultLeader',
  'FissureSiteRunner','NightPatrolUnit','SpookifiedGhoul','TheFoundation76','VaultTecEmployee',
  'SteelSentinel76','TruthOfTheMothmMan','MolratWrangler','BloatflyFarmer','GlowingSeaWalker',
  'ToxicValleyBoy','ShenandoahStrider','SavageCoalMiner','MountaineerOfDoom','RadStar76',
  'CrimsonFluxDiver','AppalachiaDefender','NukaBombshell','TheVaultEscapee','SteelDawnRising',
  'AshheapExplorer','WastelandSurgeon','CramptonRunner','LeafblowerLarry','TheBottlecapper',
  'VaultDweller76','RadstormRider','ScorecardHunter','CrusaderOfAppalachia','AtomicKnightFall',
  'NukaCherry76','BrotherhoodOfSteelFan','GhoulishGamer','ScrapYardBoss','EnclavePropagandist',
  'FoundationLoyalist','SteelDawnCrusader','CranberryGrogMaker','WastelandPhotographer','MirelurkMeals',
  'FisherOfCranberry','NightFlight76','TundraExplorer','PhosphorDreamer','VaultTechWizard',
  'AtomicAnnieMae','RaiderKingpin','CryptoWasteland','ScorchSlayer76','TheIronDrifter',
  'GhoulNation','BlueMoonlightBandit','AppalachiaGhost','NukaColaMachine','SteelReaper76',
  'TheWanderingCap','CrimsonRadRoach','MothmanBeliever','AtomSmashingTime','FissureSlayer',
  'RadRoachRodrigo','GlowingOneGaming','ToxicSludgeSurfer','WastelandWarlord','VaultPatrol76',
  'ScrappyMechanic','TheOutcastExile','RadBomber76','CranberryFogRunner','AtomFuelCell',
  'NukaBerry76','FalloutFirstMember','SteelDawnRecruit','MirelurkMeatPie','CapTraderBobby',
  'AppalachianGuitarman','SteelRainDropper','GhoulMothman','VaultDoorOpener','LegendaryFarmer76',
];

/**
 * Deterministic, seedable PRNG (mulberry32). Same seed → same sequence, so the
 * whole fake dataset is reproducible run-to-run. Returns a float in [0, 1).
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a deterministic element from `arr` using `rng`. */
export function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

export interface FakeUser {
  username: string;
  /** Deterministic, prefixed so the DELETE path (`startsWith('sim-')`) catches it. */
  installToken: string;
}

/**
 * Build `count` fake users from `SIM_NAMES`. Tokens use the `sim-seed-####`
 * prefix so they are recognised as simulation rows and are deterministic per
 * index (idempotent upsert by username).
 */
export function generateFakeUsers(count: number): FakeUser[] {
  const n = Math.max(0, Math.min(count, SIM_NAMES.length));
  const users: FakeUser[] = [];
  for (let i = 0; i < n; i++) {
    users.push({
      username: SIM_NAMES[i],
      installToken: `sim-seed-${String(i).padStart(4, '0')}`,
    });
  }
  return users;
}

// --- Message synthesis (templates only — SR-004) --------------------------

const MSG_OPENERS = [
  'Anyone up for', 'Looking for help with', 'Just finished', 'Trading',
  'Heading to', 'Who wants to run', 'Found a', 'Selling',
];
const MSG_SUBJECTS = [
  'a Scorchbeast Queen run', 'the Whitespring', 'Vault 94', 'Daily Ops',
  'an Eviction Notice', 'a Radiation Rumble', 'the Rusty Pick', 'Nuke codes',
  'a legendary 3-star weapon', 'some flux', 'a CAMP build', 'Project Paradise',
];
const MSG_CLOSERS = [
  'lmk!', 'hit me up', 'in 5 mins', 'caps only', 'fair trades only',
  'level 50+ pls', 'see you there', 'no rush', '',
];

/**
 * Synthesize a single fake message body from the static template banks.
 * Deterministic given `rng` — never derived from any real message text.
 */
export function generateFakeMessage(rng: () => number): string {
  const opener = pick(MSG_OPENERS, rng);
  const subject = pick(MSG_SUBJECTS, rng);
  const closer = pick(MSG_CLOSERS, rng);
  return `${opener} ${subject}${closer ? ' — ' + closer : ''}`;
}

// --- Party synthesis -------------------------------------------------------

const PARTY_ADJECTIVES = ['Atomic', 'Steel', 'Crimson', 'Glowing', 'Rusty', 'Wandering', 'Savage', 'Iron'];
const PARTY_NOUNS = ['Raiders', 'Squad', 'Caravan', 'Vanguard', 'Outcasts', 'Sentinels', 'Drifters', 'Crew'];
export const PARTY_CATEGORIES = ['General', 'Trading', 'Events', 'Raids'] as const;

export interface FakeParty {
  name: string;
  category: string;
  isPrivate: boolean;
}

/** Synthesize a fake party name + category. Deterministic given `rng`. */
export function generateFakeParty(rng: () => number): FakeParty {
  const name = `${pick(PARTY_ADJECTIVES, rng)} ${pick(PARTY_NOUNS, rng)}`;
  return {
    name,
    category: pick(PARTY_CATEGORIES, rng),
    isPrivate: rng() < 0.3,
  };
}

// --- Discord role-mapping formatter ----------------------------------------

/**
 * Map a source role NAME to the env-var key the dev backend expects. Matching is
 * case-insensitive and tolerant of separators ("Mod Team" → MODERATOR). Returns
 * null when a role does not correspond to a configured backend role.
 */
export function roleNameToEnvKey(name: string): string | null {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (n.includes('owner')) return 'OWNER_ROLE_ID';
  if (n.includes('admin')) return 'ADMIN_ROLE_ID';
  if (n.includes('moderator') || n === 'mod' || n.includes('modteam')) return 'MODERATOR_ROLE_ID';
  if (n.includes('developer') || n === 'dev') return 'DEVELOPER_ROLE_ID';
  return null;
}

export interface ClonedRole {
  name: string;
  id: string;
}

/**
 * Given the cloned roles in the TARGET guild, produce ready-to-paste env lines
 * for the dev backend (OWNER_ROLE_ID=…, ADMIN_ROLE_ID=…, etc.). Only roles that
 * map to a known env key are emitted; first match per key wins. Output is sorted
 * by env key for stable, copy-pasteable output.
 */
export function formatRoleEnvLines(roles: ClonedRole[]): string[] {
  const seen = new Map<string, string>();
  for (const role of roles) {
    const key = roleNameToEnvKey(role.name);
    if (key && !seen.has(key)) seen.set(key, role.id);
  }
  return Array.from(seen.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, id]) => `${key}=${id}`);
}
