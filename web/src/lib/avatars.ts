// Pixel avatars for people and their sidekicks.
//
// Each avatar is a 12x12 grid: 12 strings of 12 characters. "." is a
// transparent pixel; every other character is a key into that avatar's own
// small palette. "o" is always the dark outline so the silhouette holds on
// light and dark backgrounds alike.
//
// The id list and its order are shared with the server, which validates
// against the same sixteen names. Do not reorder or rename.

export const AVATAR_IDS = [
  "sprout", "ember", "pebble", "comet", "moss", "tide", "bolt", "wisp",
  "robo", "fox", "owl", "cat", "frog", "crab", "bat", "snail",
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

export const AVATAR_GRID = 12;

export interface AvatarDef {
  id: AvatarId;
  label: string;
  /** 12 rows of 12 characters; "." is transparent. */
  rows: string[];
  /** Maps each non-"." character used in `rows` to a #rrggbb colour. */
  palette: Record<string, string>;
}

const def = (id: AvatarId, label: string, palette: Record<string, string>, rows: string[]): AvatarDef =>
  ({ id, label, rows, palette });

export const AVATARS: Record<AvatarId, AvatarDef> = {
  // A seed with two leaves.
  sprout: def("sprout", "Sprout", { o: "#33402a", g: "#5fbf5a", l: "#a6e37a", b: "#e0b77a", p: "#e58f7c" }, [
    ".oo......oo.",
    "oggo....oggo",
    "oglgo..oglgo",
    ".ogggoogggo.",
    "..oooggooo..",
    ".obbbbbbbbo.",
    "obbbbbbbbbbo",
    "obbobbbbobbo",
    "obbobbbbobbo",
    "obpbbbbbbpbo",
    ".obbbbbbbbo.",
    "..oooooooo..",
  ]),
  // A three-tongued flame.
  ember: def("ember", "Ember", { o: "#5a1f1c", r: "#ef6a3a", y: "#ffc857" }, [
    ".....o......",
    "....oro.....",
    ".o..orro..o.",
    "oro.orro.oro",
    "orrorrrrorro",
    "orrrryyrrrro",
    "orryyyyyyrro",
    "orryoyyoyrro",
    "orryoyyoyrro",
    "orryyyyyyrro",
    ".orryyyyrro.",
    "..oooooooo..",
  ]),
  // A low, lumpy river stone.
  pebble: def("pebble", "Pebble", { o: "#333a4a", s: "#93a1b8", l: "#c3cede", d: "#6f7d96" }, [
    "............",
    "............",
    "............",
    "....ooooo...",
    "..oosssssoo.",
    ".ossllsssso.",
    "osssssssssso",
    "ossossssosso",
    "ossossssosso",
    "osdsssssssdo",
    ".osssddssso.",
    "..oooooooo..",
  ]),
  // A round head trailing a bright tail.
  comet: def("comet", "Comet", { o: "#1f2f5c", c: "#5cc8f0", y: "#ffd966", l: "#c9f0ff" }, [
    ".........ooo",
    ".......ooyyo",
    ".....ooyyyo.",
    "..ooooyyyo..",
    ".occcccyyo..",
    "occlccccyo..",
    "occcccccco..",
    "occoccocco..",
    "occoccocco..",
    "occcccccco..",
    ".occcccco...",
    "..oooooo....",
  ]),
  // A soft cushion of moss with sprigs on top.
  moss: def("moss", "Moss", { o: "#1f3d2f", g: "#4f9d69", d: "#357a50", l: "#9ad67f", w: "#e8f5d8" }, [
    "............",
    "....o..o....",
    "..oolooloo..",
    ".olglgglglo.",
    "oglgggggglgo",
    "oggggggggggo",
    "oggowggowggo",
    "ogdooggooggo",
    "oggggggggdgo",
    "ogdggooggggo",
    ".oggggggggo.",
    "..oooooooo..",
  ]),
  // A little wave with a curling crest.
  tide: def("tide", "Tide", { o: "#173a66", b: "#3f8fe0", l: "#a8d8ff", d: "#2a6fc0", w: "#eaf6ff" }, [
    "...ooooo....",
    "..owwlllooo.",
    ".owlbbbbllwo",
    ".olbbbbooowo",
    "olbbbbo...o.",
    "obbbbbbooo..",
    "obbbbbbbbbo.",
    "oblobbbobbbo",
    "obbobbbobbbo",
    "obbbbooobbdo",
    ".obbbbbbbdo.",
    "..oooooooo..",
  ]),
  // A lightning bolt.
  bolt: def("bolt", "Bolt", { o: "#5c4410", y: "#f7c531", l: "#fff0a0" }, [
    ".....oooooo.",
    "....oyllyyo.",
    "...oylyyyo..",
    "..oyyyyyo...",
    ".oyoyyoyoooo",
    "oyyoyyoyyyyo",
    "ooooyyyyyyo.",
    "...oyyyyyo..",
    "..oyyyyoo...",
    "..oyyyo.....",
    ".oyyo.......",
    ".ooo........",
  ]),
  // A puff of mist with a curling tail.
  wisp: def("wisp", "Wisp", { o: "#44306b", v: "#b79cf0", l: "#e6dbff" }, [
    "............",
    "...oooooo...",
    "..ovllvvvo..",
    ".ovlvvvvvvo.",
    ".ovvovvovvo.",
    ".ovvovvovvo.",
    ".ovvvvvvvvo.",
    "..ovvvvvvo..",
    "...oovvvo...",
    ".....ovvo...",
    "......ovvvo.",
    ".......ooo..",
  ]),
  // A boxy robot head.
  robo: def("robo", "Robo", { o: "#26323f", m: "#8fa3b3", d: "#3d5166", a: "#5ff0d0", r: "#f0705f" }, [
    "....orro....",
    ".....oo.....",
    ".oooooooooo.",
    ".ommmmmmmmo.",
    "oomddddddmoo",
    "oomdaddadmoo",
    "oomddddddmoo",
    ".ommmmmmmmo.",
    ".ommoooommo.",
    ".ommmmmmmmo.",
    ".oooooooooo.",
    "...oo..oo...",
  ]),
  // A fox face with cream cheeks.
  fox: def("fox", "Fox", { o: "#4a2413", f: "#e8793a", w: "#fbe6c8" }, [
    "oo........oo",
    "ofo......ofo",
    "offo....offo",
    "offfoooofffo",
    "offffffffffo",
    "offoffffoffo",
    "owfoffffofwo",
    "owwwffffwwwo",
    ".owwwoowwwo.",
    "..owwwwwwo..",
    "...owwwwo...",
    "....oooo....",
  ]),
  // An owl with ringed eyes.
  owl: def("owl", "Owl", { o: "#3a2a1e", b: "#a8754a", w: "#f6ead2", y: "#f2a93b", t: "#d9b98a" }, [
    ".oo......oo.",
    ".obo....obo.",
    ".obboooobbo.",
    "obbbbbbbbbbo",
    "obwwwbbwwwbo",
    "obwowbbwowbo",
    "obwwwyywwwbo",
    "obbbbyybbbbo",
    "obbttttttbbo",
    "obbtbttbtbbo",
    ".obttttttbo.",
    "..oooooooo..",
  ]),
  // A round-faced cat.
  cat: def("cat", "Cat", { o: "#2c2a3d", c: "#8d8aa8", p: "#f29bb0", g: "#c8e86a" }, [
    "............",
    ".o........o.",
    "opo......opo",
    "opco....ocpo",
    "occcooooccco",
    "occcccccccco",
    "occgccccgcco",
    "occoccccocco",
    "occccppcccco",
    "occcoccoccco",
    ".occcccccco.",
    "..oooooooo..",
  ]),
  // A frog with eyes on top.
  frog: def("frog", "Frog", { o: "#1d4a2a", g: "#6fcf4f", w: "#f4f7e4", l: "#c5ee8f" }, [
    "............",
    ".ooo....ooo.",
    "owwwo..owwwo",
    "owowoooowowo",
    "owwwggggwwwo",
    "oggggggggggo",
    "oggggggggggo",
    "ogoggggggogo",
    "oggooooooggo",
    "ogllllllllgo",
    ".oggggggggo.",
    "..oooooooo..",
  ]),
  // A crab with raised claws.
  crab: def("crab", "Crab", { o: "#5c1626", r: "#e5484d", l: "#ff9a8a" }, [
    ".o.o....o.o.",
    "ororo..ororo",
    "orrro..orrro",
    ".oro....oro.",
    ".orooooooro.",
    ".orllrrrrro.",
    "orrorrrrorro",
    "orrorrrrorro",
    "orrrrrrrrrro",
    ".orrrrrrrro.",
    ".oooooooooo.",
    ".o.o....o.o.",
  ]),
  // A bat with spread wings.
  bat: def("bat", "Bat", { o: "#2a1f47", u: "#7a5cc7", l: "#a98ee8", w: "#f4f0ff" }, [
    "...o....o...",
    "..ouo..ouo..",
    "..ouuoouuo..",
    "ooouuuuuuooo",
    "olluouuoullo",
    "olluouuoullo",
    "olluuuuuullo",
    "olluwuuwullo",
    "oloouuuuoolo",
    "oo.oouuoo.oo",
    ".....oo.....",
    "............",
  ]),
  // A snail with eyes on stalks and a spiral shell.
  snail: def("snail", "Snail", { o: "#4a3320", y: "#f0d27a", s: "#d9785a", h: "#f2b08f", w: "#fff4dc" }, [
    "ooo.ooo.....",
    "owo.owo.....",
    "ooo.ooo.....",
    ".o...o.oooo.",
    ".oyyyoosshso",
    "oyyyyyoshhso",
    "ohyyyhosshso",
    "oyyooyosssso",
    "oyyyyyoooooo",
    "oyyyyyyyyyyo",
    ".oooooooooo.",
    "............",
  ]),
};

const ID_SET: ReadonlySet<string> = new Set(AVATAR_IDS);

export function isAvatarId(value: unknown): value is AvatarId {
  return typeof value === "string" && ID_SET.has(value);
}

/** Deterministic avatar for a member who never picked one: FNV-1a 32-bit hash of the name. */
export function fallbackAvatar(name: string): AvatarId {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return AVATAR_IDS[(h >>> 0) % AVATAR_IDS.length] ?? AVATAR_IDS[0];
}
