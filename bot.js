require("dotenv").config();
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  MOD_ROLE_ID,
  ADMIN_ROLE_ID, // optional: administrators (falls back to MOD_ROLE_ID)
  ROLE_MANAGER_ROLE_ID, // optional: people who can hand out /addrole permissions
  ALERT_USER_IDS, // optional: comma-separated Discord user IDs to DM on every warning
  AUTO_KICK_AT, // optional: auto-kick in game at this many warnings (default 3, 0 = off)
  STRIKE_BAN_AT, // optional: auto-ban from Discord at this many strikes (default 0 = off)
  VERIFIED_ROLE_ID, // optional: role given when someone links their Roblox account
  NICKNAME_TEMPLATE, // optional: default "[{rank}] {name} [{branch}]"
  AUTO_CREATE_ROLES, // optional: "false" stops the bot creating rank/branch roles
  APPEAL_CATEGORY_ID, // optional: category where appeal channels are created
  WARNING_EXPIRY_DAYS, // optional: warnings stop counting toward auto-kick after this many days (default 30, 0 = never)
  TWO_WAY_BANS, // optional: "true" mirrors bans between the game and Discord for linked accounts
  CONFIRM_BUTTONS, // optional: "false" turns off the 'Are you sure?' buttons
  AUTOMOD, // optional: "true" turns on Discord auto-moderation (needs privileged intents, see README)
  ROBLOX_API_KEY,
  ROBLOX_UNIVERSE_ID,
} = process.env;

for (const [k, v] of Object.entries({
  DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, MOD_ROLE_ID, ROBLOX_API_KEY, ROBLOX_UNIVERSE_ID,
})) {
  if (!v) {
    console.error(`Missing ${k} in your .env file.`);
    process.exit(1);
  }
}

const TOPIC = "ModerationCommands"; // MessagingService topic (bot -> game)
const LOG_STORE = "DiscordLogQueue"; // DataStore queue (game -> bot), must match ModLog.lua
const RANK_STORE = "PlayerRanks"; // DataStore of last known ranks, written by DiscordBridge
const LOG_CHANNEL_NAME = "logs";
const POLL_MS = 15000;

const alertIds = (ALERT_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const autoKickAt = Number.parseInt(AUTO_KICK_AT || "3", 10);
const warningExpiryDays = Number.parseInt(WARNING_EXPIRY_DAYS || "30", 10);
const TWO_WAY = (TWO_WAY_BANS || "false").toLowerCase() === "true";
const CONFIRM_ON = (CONFIRM_BUTTONS || "true").toLowerCase() !== "false";
const AUTOMOD_ON = (AUTOMOD || "false").toLowerCase() === "true";
const strikeBanAt = Number.parseInt(STRIKE_BAN_AT || "0", 10);
// Nickname for linked members. Placeholders: {rank} {name} {display} {branch}
const NICK_TEMPLATE = NICKNAME_TEMPLATE || "[{rank}] {name} [{branch}]";
const HIDE_BRANCH_CODES = new Set(["USAF_ALL"]); // branches that don't get a [TAG] in the nickname

// Members get ONE tier role (below) plus ONE branch role. Edit the names/colors here if you like.
const TIER_NAMES = {
  Enlisted: "Enlisted",
  Officer: "Officer",
  "Command Staff": "Command Staff",
  "Senior Command": "Senior Command",
};
const TIER_COLORS = {
  Enlisted: 0x95a5a6,
  Officer: 0x3498db,
  "Command Staff": 0xf1c40f,
  "Senior Command": 0xe74c3c,
};
// Rank codes that count as Command Staff (Joint Chiefs and above, same as RankModule)
const COMMAND_STAFF_CODES = new Set(["CJCS", "VCJCS", "LDR", "VLDR", "SEL", "O11"]);
const AUTO_CREATE = (AUTO_CREATE_ROLES || "true").toLowerCase() !== "false";
const RANK_RE = /^(E[1-9]|W[1-5]|O([1-9]|10))$/; // assignable rank codes

// Roles with any of these permissions are never handed out or created by the bot.
const DANGEROUS_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
];

// Commands anyone can use
const PUBLIC_COMMANDS = new Set(["verify", "unlink", "update", "help", "report"]);
// These check access themselves inside their handler
const SELF_CHECKED = new Set(["addrole", "removerole", "permission"]);

// ---------- Tiny JSON database (saved next to bot.js as data.json) ----------
const DATA_DIR = process.env.DATA_DIR || __dirname; // hosting: point this at a persistent volume
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "data.json");
let db = {
  warnings: {}, links: {}, bans: {}, appeals: {}, perms: {}, dmlogs: {},
  notes: {}, rankHistory: {}, activity: {}, shifts: { active: {}, log: [] }, reports: {}, tickets: {}, meta: {},
};
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) };
} catch {
  /* first run */
}
function saveDb() {
  fs.writeFileSync(DB_PATH + ".tmp", JSON.stringify(db, null, 2));
  fs.renameSync(DB_PATH + ".tmp", DB_PATH);
}
const pendingLinks = new Map(); // discordId -> { id, name, phrase, expires }

// Tiny event bus so feature files can react to things (rank changes, game reports, timers...)
const events = {
  listeners: {},
  on(name, fn) { (this.listeners[name] ||= []).push(fn); },
  async emit(name, payload) {
    for (const fn of this.listeners[name] || []) {
      try { await fn(payload); } catch (e) { console.error(`Error in "${name}" handler:`, e); }
    }
  },
};

// ---------- Slash command definitions ----------
const username = (o) => o.setName("username").setDescription("Roblox username").setRequired(true);
const reasonReq = (o) => o.setName("reason").setDescription("Reason").setRequired(true).setMaxLength(200);
const userOpt = (name = "user", desc = "Discord member") => (o) =>
  o.setName(name).setDescription(desc).setRequired(true);

const PERM_TYPES = [
  { name: "Give a specific role (/addrole)", value: "addrole" },
  { name: "Run background checks", value: "backgroundcheck" },
];

const modCommands = [
  // ----- Roblox game moderation -----
  new SlashCommandBuilder().setName("kick").setDescription("Kick a player from the game")
    .addStringOption(username).addStringOption(reasonReq),

  new SlashCommandBuilder().setName("ban").setDescription("Ban a player from the game")
    .addStringOption(username).addStringOption(reasonReq)
    .addIntegerOption((o) =>
      o.setName("days").setDescription("Ban length in days (empty = permanent)").setMinValue(1)),

  new SlashCommandBuilder().setName("unban").setDescription("Unban a player")
    .addStringOption(username)
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setMaxLength(200)),

  new SlashCommandBuilder().setName("warn").setDescription("Warn a player (shows the warning pop-up in game)")
    .addStringOption(username).addStringOption(reasonReq),

  new SlashCommandBuilder().setName("warnings").setDescription("Show a player's warning history")
    .addStringOption(username),

  new SlashCommandBuilder().setName("clearwarnings").setDescription("Clear a player's warning history")
    .addStringOption(username),

  new SlashCommandBuilder().setName("rank").setDescription("Set a player's rank")
    .addStringOption(username)
    .addStringOption((o) =>
      o.setName("rank").setDescription("Rank code, e.g. E5, W2, O3").setRequired(true)),

  new SlashCommandBuilder().setName("branchaccess").setDescription("Grant or revoke access to a restricted branch")
    .addStringOption((o) =>
      o.setName("action").setDescription("Grant or revoke").setRequired(true)
        .addChoices({ name: "Grant", value: "grant" }, { name: "Revoke", value: "revoke" }))
    .addStringOption(username)
    .addStringOption((o) =>
      o.setName("branch").setDescription("Restricted branch").setRequired(true)
        .addChoices({ name: "United States Headquarters", value: "USHQ" })),

  new SlashCommandBuilder().setName("give").setDescription("Give a player an item from ServerStorage.Items")
    .addStringOption(username)
    .addStringOption((o) =>
      o.setName("item").setDescription("Exact item name").setRequired(true).setMaxLength(80)),

  new SlashCommandBuilder().setName("announce").setDescription("Show an announcement to everyone in the game")
    .addStringOption((o) =>
      o.setName("message").setDescription("Announcement text").setRequired(true).setMaxLength(300)),

  new SlashCommandBuilder().setName("protocol").setDescription("Set the in-game protocol notice")
    .addStringOption((o) =>
      o.setName("text").setDescription("Protocol text").setRequired(true).setMaxLength(300)),

  new SlashCommandBuilder().setName("whois").setDescription("See which Roblox account a Discord user is linked to")
    .addUserOption((o) => o.setName("member").setDescription("Discord member"))
    .addStringOption((o) => o.setName("username").setDescription("Or a Roblox username")),

  new SlashCommandBuilder().setName("appealpanel").setDescription("Post the 'Open an appeal' button in this channel"),

  new SlashCommandBuilder().setName("promote").setDescription("Promote a player up their rank track (player must be in the game)")
    .addStringOption(username)
    .addIntegerOption((o) =>
      o.setName("steps").setDescription("How many ranks to move up (default 1)").setMinValue(1).setMaxValue(5))
    .addStringOption((o) => o.setName("reason").setDescription("Reason or note").setMaxLength(200)),

  new SlashCommandBuilder().setName("demote").setDescription("Demote a player down their rank track (player must be in the game)")
    .addStringOption(username)
    .addIntegerOption((o) =>
      o.setName("steps").setDescription("How many ranks to move down (default 1)").setMinValue(1).setMaxValue(5))
    .addStringOption((o) => o.setName("reason").setDescription("Reason or note").setMaxLength(200)),

  new SlashCommandBuilder().setName("createrole").setDescription("Create a new role (admins only)")
    .addStringOption((o) => o.setName("name").setDescription("Role name").setRequired(true).setMaxLength(100))
    .addStringOption((o) => o.setName("color").setDescription("Hex like #ff0000, or a name like red, blue, gold"))
    .addBooleanOption((o) => o.setName("hoist").setDescription("Show members of this role separately in the member list"))
    .addBooleanOption((o) => o.setName("mentionable").setDescription("Let anyone @mention this role")),

  new SlashCommandBuilder().setName("editrole").setDescription("Change a role's name or color (admins only)")
    .addRoleOption((o) => o.setName("role").setDescription("Role to edit").setRequired(true))
    .addStringOption((o) => o.setName("name").setDescription("New name").setMaxLength(100))
    .addStringOption((o) => o.setName("color").setDescription("Hex like #ff0000, a name like red, or 'none'"))
    .addBooleanOption((o) => o.setName("hoist").setDescription("Show members of this role separately in the member list"))
    .addBooleanOption((o) => o.setName("mentionable").setDescription("Let anyone @mention this role")),

  // ----- Discord server moderation -----
  new SlashCommandBuilder().setName("dmod").setDescription("Discord server moderation")
    .addSubcommand((s) => s.setName("kick").setDescription("Kick a member from the Discord server")
      .addUserOption(userOpt()).addStringOption(reasonReq))
    .addSubcommand((s) => s.setName("ban").setDescription("Ban a member from the Discord server")
      .addUserOption(userOpt()).addStringOption(reasonReq)
      .addIntegerOption((o) =>
        o.setName("delete_days").setDescription("Delete their messages from the last X days (0-7)")
          .setMinValue(0).setMaxValue(7)))
    .addSubcommand((s) => s.setName("unban").setDescription("Unban a user from the Discord server")
      .addUserOption(userOpt())
      .addStringOption((o) => o.setName("reason").setDescription("Reason").setMaxLength(200)))
    .addSubcommand((s) => s.setName("timeout").setDescription("Timeout (mute) a member")
      .addUserOption(userOpt())
      .addIntegerOption((o) =>
        o.setName("minutes").setDescription("How long, in minutes (max 40320 = 28 days)")
          .setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption(reasonReq))
    .addSubcommand((s) => s.setName("untimeout").setDescription("Remove a member's timeout")
      .addUserOption(userOpt()))
    .addSubcommand((s) => s.setName("warn").setDescription("Warn a member (recorded, no punishment)")
      .addUserOption(userOpt()).addStringOption(reasonReq))
    .addSubcommand((s) => s.setName("strike").setDescription("Give a member a strike (counts toward auto-ban)")
      .addUserOption(userOpt()).addStringOption(reasonReq))
    .addSubcommand((s) => s.setName("history").setDescription("Check a member's moderation history")
      .addUserOption(userOpt()))
    .addSubcommand((s) => s.setName("clearhistory").setDescription("Clear a member's moderation history")
      .addUserOption(userOpt()))
    .addSubcommand((s) => s.setName("purge").setDescription("Delete recent messages in this channel")
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("How many (1-100)").setRequired(true).setMinValue(1).setMaxValue(100))),
].map((c) => c.toJSON()); // visible to everyone; the bot checks permissions itself

// No default permission here: anyone can see these, and the bot checks access itself
const publicCommands = [
  new SlashCommandBuilder().setName("verify").setDescription("Link your Roblox account to your Discord")
    .addStringOption(username),
  new SlashCommandBuilder().setName("unlink").setDescription("Unlink your Roblox account"),
  new SlashCommandBuilder().setName("update").setDescription("Update your nickname and rank/branch roles from the game"),

  new SlashCommandBuilder().setName("addrole").setDescription("Give a member a role (needs permission)")
    .addUserOption(userOpt("member")).addRoleOption((o) =>
      o.setName("role").setDescription("Role to give").setRequired(true)),
  new SlashCommandBuilder().setName("removerole").setDescription("Remove a role from a member (needs permission)")
    .addUserOption(userOpt("member")).addRoleOption((o) =>
      o.setName("role").setDescription("Role to remove").setRequired(true)),

  new SlashCommandBuilder().setName("backgroundcheck").setDescription("Run a background check on a Roblox player (needs permission)")
    .addStringOption(username),

  new SlashCommandBuilder().setName("permission").setDescription("Manage who is allowed to use which commands")
    .addSubcommand((s) => s.setName("grant").setDescription("Give someone a permission (or a preset)")
      .addUserOption(userOpt("member"))
      .addStringOption((o) =>
        o.setName("permission").setDescription("Permission or preset (start typing to search)").setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) =>
        o.setName("days").setDescription("Expires after this many days (empty = never)").setMinValue(1).setMaxValue(365))
      .addRoleOption((o) => o.setName("role").setDescription("For addrole: the role they're allowed to give")))
    .addSubcommand((s) => s.setName("revoke").setDescription("Take a permission (or preset) away")
      .addUserOption(userOpt("member"))
      .addStringOption((o) =>
        o.setName("permission").setDescription("Permission or preset").setRequired(true).setAutocomplete(true))
      .addRoleOption((o) => o.setName("role").setDescription("For addrole: one role (empty = all roles)")))
    .addSubcommand((s) => s.setName("list").setDescription("See what someone is allowed to do")
      .addUserOption(userOpt("member")))
    .addSubcommand((s) => s.setName("mine").setDescription("See what you are allowed to do"))
    .addSubcommand((s) => s.setName("presets").setDescription("See the permission presets")),
].map((c) => c.toJSON());

const commands = [...modCommands, ...publicCommands];

// ---------- Helpers ----------
const eph = { flags: MessageFlags.Ephemeral };
const hasRole = (member, id) => Boolean(id && member?.roles?.cache?.has(id));
const isAdmin = (member) => hasRole(member, ADMIN_ROLE_ID || MOD_ROLE_ID);
const isMod = (member) => hasRole(member, MOD_ROLE_ID) || isAdmin(member);
const isRoleManager = (member) => isAdmin(member) || hasRole(member, ROLE_MANAGER_ROLE_ID);
const nowUnix = () => Math.floor(Date.now() / 1000);

// ---------- Permissions ----------
// Every sensitive command needs a permission. Administrators (ADMIN_ROLE_ID) and the server owner
// can do everything. Everyone else needs an administrator to grant them what they need, either one
// permission at a time or a preset, optionally for a limited number of days.
const PERMISSION_DEFS = [
  // [node, group, description, adminOnly?]
  ["kick", "Game moderation", "Kick players from the game"],
  ["ban", "Game moderation", "Ban players from the game"],
  ["unban", "Game moderation", "Unban players"],
  ["warn", "Game moderation", "Warn players"],
  ["warnings", "Game moderation", "View a player's warning history"],
  ["clearwarnings", "Game moderation", "Clear a player's warnings"],
  ["notes", "Game moderation", "Add, view and remove player notes"],
  ["freeze", "Game moderation", "Freeze and unfreeze players"],
  ["message", "Game moderation", "Send private pop-up messages to players"],
  ["rank", "Ranks", "Set a player's rank directly (/rank)"],
  ["promote", "Ranks", "Promote and demote players"],
  ["branchaccess", "Ranks", "Grant or revoke restricted branch access"],
  ["give", "Ranks", "Give items to players"],
  ["announce", "Game control", "Send in-game announcements"],
  ["protocol", "Game control", "Set the in-game protocol notice"],
  ["players", "Game control", "See who is in the game"],
  ["lockdown", "Game control", "Lock the game to new players"],
  ["shutdown", "Game control", "Kick everyone and lock the game", true],
  ["checkban", "Records", "Check bans (/checkban and /banlist)"],
  ["whois", "Records", "Look up Discord and Roblox links"],
  ["backgroundcheck", "Records", "Run background checks"],
  ["activity", "Records", "View player activity (/activity, /inactive, /topactive)"],
  ["rankhistory", "Records", "View a player's rank history"],
  ["dmod.kick", "Discord moderation", "Kick members from the Discord server"],
  ["dmod.ban", "Discord moderation", "Ban members from the Discord server"],
  ["dmod.unban", "Discord moderation", "Unban members from the Discord server"],
  ["dmod.timeout", "Discord moderation", "Timeout members"],
  ["dmod.untimeout", "Discord moderation", "Remove timeouts"],
  ["dmod.warn", "Discord moderation", "Warn members"],
  ["dmod.strike", "Discord moderation", "Give members strikes"],
  ["dmod.history", "Discord moderation", "View a member's moderation history"],
  ["dmod.clearhistory", "Discord moderation", "Clear a member's moderation history"],
  ["dmod.purge", "Discord moderation", "Delete messages in bulk"],
  ["roles.manage", "Server", "Create and edit roles"],
  ["addrole", "Server", "Give or remove specific roles (you choose which)"],
  ["panels", "Server", "Post verify, appeal and application panels"],
  ["appeals.review", "Server", "Deny and close appeals"],
  ["appeals.accept", "Server", "Accept appeals (unbans the player)"],
  ["tickets.review", "Server", "Accept and deny promotion/branch applications"],
  ["reports.handle", "Server", "Handle player reports"],
  ["automod", "Server", "Control raid mode and auto-moderation"],
  ["shift", "Staff", "Clock in and out of shifts"],
  ["shifts.view", "Staff", "See everyone's shift hours"],
  ["backup", "Admin tools", "Download a backup of the bot's data", true],
  ["syncall", "Admin tools", "Refresh everyone's nickname and roles", true],
];
const PERMISSIONS = Object.fromEntries(
  PERMISSION_DEFS.map(([node, group, desc, locked]) => [node, { group, desc, locked: Boolean(locked) }])
);

const trialNodes = ["warn", "warnings", "dmod.warn", "dmod.history", "players", "whois", "shift"];
const modNodes = [
  ...trialNodes, "kick", "freeze", "message", "notes", "checkban", "activity", "rankhistory",
  "dmod.kick", "dmod.timeout", "dmod.untimeout", "dmod.strike", "dmod.purge", "appeals.review", "reports.handle",
];
const seniorNodes = [
  ...modNodes, "ban", "unban", "clearwarnings", "backgroundcheck", "dmod.ban", "dmod.unban", "dmod.clearhistory",
  "appeals.accept", "tickets.review", "shifts.view",
];
const rankNodes = ["rank", "promote", "branchaccess", "give", "tickets.review", "rankhistory"];
const PRESETS = {
  trial: { desc: "Trial moderator: warn, look things up, clock in", nodes: trialNodes },
  mod: { desc: "Moderator: kick, freeze, timeouts, appeals, reports", nodes: modNodes },
  senior: { desc: "Senior moderator: bans, background checks, accepting appeals", nodes: seniorNodes },
  ranks: { desc: "Rank manager: ranks, promotions, branch access, items", nodes: rankNodes },
  lead: {
    desc: "Staff lead: senior + ranks + announcements, lockdown, roles, panels",
    nodes: [...seniorNodes, ...rankNodes, "announce", "protocol", "lockdown", "automod", "panels", "roles.manage"],
  },
};

const isOwner = (member) => Boolean(member?.guild && member.id === member.guild.ownerId);
const isAdminLike = (member) => isOwner(member) || isAdmin(member);

function hasPerm(member, node) {
  if (!member) return false;
  if (isAdminLike(member)) return true;
  if (PERMISSIONS[node]?.locked) return false;
  const entry = db.perms[member.id];
  if (!entry) return false;
  const expires = entry.nodes?.[node];
  if (expires !== undefined && (expires === null || expires > nowUnix())) return true;
  return node === "backgroundcheck" && entry.backgroundcheck === true; // grants from older versions
}

// Which permission a slash command needs
const COMMAND_NODES = {
  demote: "promote", unfreeze: "freeze", banlist: "checkban", createrole: "roles.manage", editrole: "roles.manage",
  appealpanel: "panels", applypanel: "panels", verifypanel: "panels", note: "notes", inactive: "activity",
  topactive: "activity", shifts: "shifts.view", raidmode: "automod",
};
function nodeFor(i) {
  if (i.commandName === "dmod") return `dmod.${i.options.getSubcommand()}`;
  return COMMAND_NODES[i.commandName] ?? i.commandName;
}

const lastDenied = new Map();
async function logDenied(i, node) {
  const key = `${i.user.id}:${node}`;
  if (Date.now() - (lastDenied.get(key) || 0) < 60000) return;
  lastDenied.set(key, Date.now());
  const sub = i.options.getSubcommand(false);
  await sendLog(buildLogEmbed({
    source: "Discord", type: "Permission Denied", moderator: `${i.user.tag} (${i.user.id})`, byLabel: "User",
    details: `Tried /${i.commandName}${sub ? " " + sub : ""} (needs "${node}")`,
  })).catch(() => {});
}
const fmtMinutes = (m) =>
  m % 1440 === 0 ? `${m / 1440} day(s)` : m % 60 === 0 ? `${m / 60} hour(s)` : `${m} minute(s)`;

const robloxHeaders = { "x-api-key": ROBLOX_API_KEY };

async function getUser(name) {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }),
  });
  if (!res.ok) throw new Error(`Roblox user lookup failed (${res.status})`);
  const data = await res.json();
  return data.data?.[0] ?? null;
}

async function getProfile(id) {
  const res = await fetch(`https://users.roblox.com/v1/users/${id}`);
  if (!res.ok) throw new Error(`Roblox profile lookup failed (${res.status})`);
  return res.json();
}

async function sendToGame(payload) {
  const res = await fetch(
    `https://apis.roblox.com/messaging-service/v1/universes/${ROBLOX_UNIVERSE_ID}/topics/${TOPIC}`,
    {
      method: "POST",
      headers: { ...robloxHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ message: JSON.stringify(payload) }),
    }
  );
  if (!res.ok) throw new Error(`Roblox API error ${res.status}: ${await res.text()}`);
}

const dsBase = () =>
  `https://apis.roblox.com/datastores/v1/universes/${ROBLOX_UNIVERSE_ID}/standard-datastores/datastore/entries`;

// Last known in-game rank/branch for a player (written by DiscordBridge.server.lua)
async function getRankSnapshot(robloxId) {
  const q = `datastoreName=${RANK_STORE}&entryKey=${encodeURIComponent(robloxId)}`;
  const res = await fetch(`${dsBase()}/entry?${q}`, { headers: robloxHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Rank lookup failed (${res.status})`);
  return res.json();
}

function linkedDiscordId(robloxId) {
  for (const [discordId, link] of Object.entries(db.links)) {
    if (String(link.id) === String(robloxId)) return discordId;
  }
  return null;
}

async function dmDiscord(discordId, payload) {
  try {
    const user = await client.users.fetch(discordId);
    await user.send(payload);
    return true;
  } catch (e) {
    console.warn(`Couldn't DM ${discordId}: ${e.message}`);
    return false;
  }
}

const dmPlayer = (robloxId, payload) => {
  const discordId = linkedDiscordId(robloxId);
  return discordId ? dmDiscord(discordId, payload) : Promise.resolve(false);
};

// ---------- Logging ----------
function buildLogEmbed({ source, type, target, targetLabel, moderator, byLabel, reason, details, time }) {
  const unix = time || nowUnix();
  const isWarn = type === "Warning";
  const embed = new EmbedBuilder()
    .setTitle(`[${source}] ${type}`)
    .setColor(source === "Roblox" ? 0xe67e22 : 0x5865f2)
    .setFooter({ text: `Source: ${source}` })
    .setTimestamp(unix * 1000)
    .addFields({ name: "Date & Time", value: `<t:${unix}:F> (<t:${unix}:R>)` });
  if (target) {
    embed.addFields({
      name: targetLabel || (isWarn ? "Warning given to" : "Player"),
      value: `${target.name} (${target.id})`,
      inline: true,
    });
  }
  if (moderator) {
    embed.addFields({
      name: byLabel || (isWarn ? "Warning given by" : "Moderator"),
      value: String(moderator).slice(0, 1024),
      inline: true,
    });
  }
  if (reason) embed.addFields({ name: "Reason", value: String(reason).slice(0, 1024) });
  if (details) embed.addFields({ name: "Details", value: String(details).slice(0, 1024) });
  return embed;
}

async function sendLog(embed) {
  try {
    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    const channels = await guild.channels.fetch();
    const channel = channels.find(
      (c) => c && c.type === ChannelType.GuildText && c.name === LOG_CHANNEL_NAME
    );
    if (!channel) {
      console.warn(`No #${LOG_CHANNEL_NAME} channel found.`);
      return false;
    }
    await channel.send({ embeds: [embed] });
    return true;
  } catch (e) {
    console.error("Couldn't send log:", e.message);
    return false;
  }
}

async function dmAlerts(embed, source) {
  for (const id of alertIds) {
    await dmDiscord(id, {
      content: `⚠️ **A warning was just issued** (from ${source}). Details below:`,
      embeds: [embed],
    });
  }
}

const notice = (title, description, color = 0xed4245) =>
  new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();

// ---------- Roblox warnings (log + history + DMs + auto-kick) ----------
const isActiveWarning = (w) => !(warningExpiryDays > 0) || w.time > nowUnix() - warningExpiryDays * 86400;

function addRankHistory(robloxId, entry) {
  const list = (db.rankHistory[String(robloxId)] ||= []);
  list.push({ time: nowUnix(), ...entry });
  if (list.length > 100) list.shift();
  saveDb();
}

// Seconds a player was in the game over the last N days (filled in by the activity tracker)
function activitySeconds(robloxId, days) {
  const act = db.activity[String(robloxId)];
  if (!act?.days) return 0;
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  return Object.entries(act.days).filter(([d]) => d >= cutoff).reduce((n, [, secs]) => n + secs, 0);
}

async function findChannelByName(name) {
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const channels = await guild.channels.fetch();
  return channels.find((c) => c && c.type === ChannelType.GuildText && c.name === name) || null;
}
async function processWarning({ source, target, moderator, reason, time }) {
  const embed = buildLogEmbed({ source, type: "Warning", target, moderator, reason, time });
  const logged = await sendLog(embed);
  if (!logged && source === "Roblox") return { embed, logged, retry: true };

  const key = String(target.id);
  (db.warnings[key] ||= []).push({
    name: target.name, by: moderator, reason, source, time: time || nowUnix(),
  });
  saveDb();
  const count = db.warnings[key].filter(isActiveWarning).length; // expired warnings don't count

  await dmAlerts(embed, source);
  await dmPlayer(target.id, {
    embeds: [
      notice(
        "You received a warning",
        `**Reason:** ${reason}\n**Active warnings:** ${count}` +
          (autoKickAt > 0 ? `\nYou'll be kicked automatically at ${autoKickAt} warnings.` : "")
      ),
    ],
  });

  if (autoKickAt > 0 && count >= autoKickAt) {
    const why = `Auto-kick: reached ${count} active warnings`;
    try {
      await sendToGame({ action: "kick", userId: target.id, reason: why, moderator: "Auto-moderation" });
    } catch (e) {
      console.error("Auto-kick failed:", e.message);
    }
    const kickEmbed = buildLogEmbed({
      source: "Discord", type: "Auto-Kick", target, moderator: "Auto-moderation", reason: why,
    });
    await sendLog(kickEmbed);
    await dmPlayer(target.id, { embeds: [notice("You were kicked", why)] });
  }
  return { embed, logged, count };
}

// ---------- Roblox -> Discord log queue ----------
let polling = false;

const ROBLOX_TYPES = {
  warn: "Warning",
  rank: "Rank Change",
  branch: "Branch Change",
  join: "Player Joined",
  leave: "Player Left",
};

async function pollRobloxLogs() {
  if (polling) return;
  polling = true;
  try {
    const list = await fetch(`${dsBase()}?datastoreName=${LOG_STORE}&prefix=log_&limit=25`, { headers: robloxHeaders });
    if (!list.ok) {
      if (list.status !== 404) console.warn(`Log poll failed (${list.status}): ${await list.text()}`);
      return;
    }
    const { keys = [] } = await list.json();
    for (const { key } of keys) {
      if (!key.startsWith("log_")) continue; // skip promote/demote replies (res_...)
      const q = `datastoreName=${LOG_STORE}&entryKey=${encodeURIComponent(key)}`;
      const get = await fetch(`${dsBase()}/entry?${q}`, { headers: robloxHeaders });
      if (!get.ok) continue;
      const e = await get.json();

      const target = e.target || { name: "Unknown", id: "?" };
      const moderator = e.moderator ? `${e.moderator.name} (${e.moderator.id})` : null;

      if (e.type === "session" || e.type === "report") {
        await events.emit(e.type, e); // handled by feature code, not posted as a log
      } else if (e.type === "warn") {
        const res = await processWarning({
          source: "Roblox", target, moderator: moderator || "Unknown", reason: e.reason, time: e.time,
        });
        if (res.retry) return; // keep the entry, try again next poll
      } else {
        const embed = buildLogEmbed({
          source: "Roblox",
          type: ROBLOX_TYPES[e.type] || String(e.type || "Event"),
          target,
          moderator,
          reason: e.reason,
          details: e.details,
          time: e.time,
        });
        if (!(await sendLog(embed))) return;
        if (e.type === "rank" || e.type === "branch") {
          scheduleAutoSync(target.id, 6000);
          addRankHistory(target.id, { type: e.type === "rank" ? "Rank change" : "Branch change", change: e.details || "", by: "In-game", source: "Roblox" });
        }
      }
      await fetch(`${dsBase()}/entry?${q}`, { method: "DELETE", headers: robloxHeaders });
    }
  } catch (err) {
    console.error("Roblox log poll error:", err.message);
  } finally {
    polling = false;
  }
}

// ---------- Discord client ----------
const intents = [GatewayIntentBits.Guilds];
if (AUTOMOD_ON) intents.push(GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
const client = new Client({ intents });

client.once("clientReady", async () => {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: commands });
  console.log(`Logged in as ${client.user.tag}, commands registered.`);
  setInterval(pollRobloxLogs, POLL_MS);
  pollRobloxLogs();

  if (!ADMIN_ROLE_ID) {
    console.warn("⚠️  ADMIN_ROLE_ID isn't set, so everyone with the mod role counts as an administrator and has every permission. Set ADMIN_ROLE_ID to a separate role.");
  }
  for (const f of features) {
    try { await f.init?.(); } catch (e) { console.error("Feature failed to start:", e); }
  }
  setInterval(() => events.emit("tick", new Date()), 60000);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await onAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await onCommand(interaction);
    if (interaction.isButton()) return await onButton(interaction);
    if (interaction.isModalSubmit()) return await onModal(interaction);
  } catch (err) {
    console.error(err);
    const msg = `Something went wrong: ${err.message}`;
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply({ content: msg, ...eph });
    } catch {
      /* nothing more we can do */
    }
  }
});

// ---------- Slash commands ----------
async function onCommand(i) {
  const name = i.commandName;
  if (!PUBLIC_COMMANDS.has(name) && !SELF_CHECKED.has(name)) {
    const node = nodeFor(i);
    if (!hasPerm(i.member, node)) {
      logDenied(i, node);
      return i.reply({
        content: `You don't have permission to use this. It needs the **${node}** permission. Ask an administrator to grant it with \`/permission grant\`.`,
        ...eph,
      });
    }
  }
  await i.deferReply(eph);
  if (needsConfirm(i)) return askConfirm(i);
  return runCommand(i);
}

async function runCommand(i) {
  const name = i.commandName;
  if (featureCommands[name]) return featureCommands[name](i);

  switch (name) {
    case "warnings": return showWarnings(i);
    case "clearwarnings": return clearWarnings(i);
    case "announce":
    case "protocol": return broadcast(i);
    case "whois": return whois(i);
    case "verify": return startVerify(i);
    case "unlink": return unlink(i);
    case "update": return updateCommand(i);
    case "appealpanel": return appealPanel(i);
    case "promote":
    case "demote": return promoteDemote(i);
    case "createrole": return createRoleCommand(i);
    case "editrole": return editRoleCommand(i);
    case "dmod": return dmod(i);
    case "permission": return permissionCommand(i);
    case "addrole":
    case "removerole": return roleCommand(i);
    case "backgroundcheck": return backgroundCheck(i);
    default: return playerAction(i); // kick, ban, unban, warn, rank, branchaccess, give
  }
}

// ----- "Are you sure?" buttons for risky commands -----
const CONFIRM_NODES = new Set(["ban", "clearwarnings", "dmod.ban", "dmod.purge", "dmod.clearhistory", "shutdown"]);
const pendingConfirms = new Map();

function needsConfirm(i) {
  if (!CONFIRM_ON || i._confirmed) return false;
  if (CONFIRM_NODES.has(nodeFor(i))) return true;
  return i.commandName === "lockdown" && i.options.getString("mode") === "on";
}

function describeCommand(i) {
  const sub = i.options.getSubcommand(false);
  const opts = (sub ? i.options.data[0]?.options : i.options.data) || [];
  const parts = opts.map((o) => `${o.name}: ${o.user ? o.user.tag : o.role ? o.role.name : o.value}`);
  return `/${i.commandName}${sub ? " " + sub : ""} ${parts.join(", ")}`.replace(/`/g, "'").trim().slice(0, 900);
}

async function askConfirm(i) {
  const id = crypto.randomBytes(5).toString("hex");
  pendingConfirms.set(id, { i });
  setTimeout(() => {
    if (pendingConfirms.delete(id)) {
      i.editReply({ content: "⌛ Timed out. Nothing was done.", components: [], embeds: [] }).catch(() => {});
    }
  }, 60000);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm:${id}:yes`).setLabel("Yes, do it").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`confirm:${id}:no`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
  await i.editReply({ content: `⚠️ **Are you sure?**\n\`${describeCommand(i)}\``, components: [row] });
}

async function handleConfirm(ci, id, answer) {
  const pending = pendingConfirms.get(id);
  if (!pending) return ci.reply({ content: "This confirmation expired.", ...eph });
  if (ci.user.id !== pending.i.user.id) {
    return ci.reply({ content: "Only the person who ran the command can confirm it.", ...eph });
  }
  pendingConfirms.delete(id);
  await ci.deferUpdate();

  const original = pending.i;
  if (answer !== "yes") return original.editReply({ content: "Cancelled. Nothing was done.", components: [], embeds: [] });

  await original.editReply({ content: "⏳ Working on it...", components: [], embeds: [] });
  original._confirmed = true;
  try {
    await runCommand(original);
  } catch (err) {
    console.error(err);
    await original.editReply(`Something went wrong: ${err.message}`).catch(() => {});
  }
}

async function lookup(i) {
  const uname = i.options.getString("username");
  const user = await getUser(uname);
  if (!user) {
    await i.editReply(`Couldn't find a Roblox user named **${uname}**.`);
    return null;
  }
  return { name: user.name, id: user.id };
}

async function playerAction(i) {
  const name = i.commandName;
  const target = await lookup(i);
  if (!target) return;

  const modTag = `${i.user.tag} (${i.user.id})`;
  const reason = i.options.getString("reason");
  let payload, type, details, note;

  switch (name) {
    case "kick":
      payload = { action: "kick" };
      type = "Kick";
      break;
    case "ban": {
      const days = i.options.getInteger("days");
      payload = { action: "ban", duration: days ? days * 86400 : -1 };
      type = "Ban";
      details = days ? `Length: ${days} day(s)` : "Length: Permanent";
      break;
    }
    case "unban":
      payload = { action: "unban" };
      type = "Unban";
      break;
    case "warn":
      payload = { action: "warn" };
      type = "Warning";
      note = "Players only see the pop-up if they're in the game right now. It's logged either way.";
      break;
    case "rank": {
      const rank = i.options.getString("rank").replace(/\s/g, "").toUpperCase();
      if (!RANK_RE.test(rank)) {
        return i.editReply("That isn't an assignable rank code. Use E1-E9, W1-W5 or O1-O10.");
      }
      payload = { action: "rank", rank };
      type = "Rank Change";
      details = `New rank: ${rank}`;
      note = "Applies to players currently in the game. If they're linked, their Discord roles update shortly after.";
      break;
    }
    case "branchaccess": {
      const mode = i.options.getString("action");
      const branch = i.options.getString("branch");
      payload = { action: "branchaccess", mode, branch };
      type = "Branch Access";
      details = `${mode === "grant" ? "Granted" : "Revoked"} access to ${branch}`;
      break;
    }
    case "give": {
      const item = i.options.getString("item");
      payload = { action: "give", item };
      type = "Item Given";
      details = `Item: ${item}`;
      note = "The player must be in the game, and the item must be a Tool in ServerStorage.Items.";
      break;
    }
  }

  await sendToGame({ ...payload, userId: target.id, reason, moderator: i.user.username });
  if (name === "rank") {
    scheduleAutoSync(target.id, 8000);
    addRankHistory(target.id, { type: "Rank set", change: details, by: modTag, source: "Discord" });
  }

  let embed, logged, extra = "";
  if (name === "warn") {
    const res = await processWarning({ source: "Discord", target, moderator: modTag, reason });
    ({ embed, logged } = res);
    extra = `\n${target.name} now has **${res.count}** active warning(s).` +
      (autoKickAt > 0 && res.count >= autoKickAt ? " They were auto-kicked." : "");
  } else {
    embed = buildLogEmbed({ source: "Discord", type, target, moderator: modTag, reason, details });
    logged = await sendLog(embed);
  }

  // DMs and records for linked players
  if (name === "kick") {
    await dmPlayer(target.id, { embeds: [notice("You were kicked", `**Reason:** ${reason}`)] });
  } else if (name === "ban") {
    const days = i.options.getInteger("days");
    db.bans[String(target.id)] = {
      name: target.name, reason, by: modTag, time: nowUnix(), length: days ? `${days} day(s)` : "Permanent",
    };
    saveDb();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`appeal_open:${target.id}:${target.name}`)
        .setLabel("Appeal this ban")
        .setStyle(ButtonStyle.Primary)
    );
    await dmPlayer(target.id, {
      embeds: [notice("You were banned", `**Reason:** ${reason}\n**Length:** ${details.replace("Length: ", "")}`)],
      components: [row],
    });
  } else if (name === "unban") {
    delete db.bans[String(target.id)];
    saveDb();
    await dmPlayer(target.id, { embeds: [notice("You were unbanned", "You can rejoin the game.", 0x57f287)] });
  }

  if (name === "ban" || name === "unban") {
    const mirrored = await mirrorGameBan(name, target, reason || "No reason", modTag);
    if (mirrored) extra += `\n🔁 ${mirrored}`;
  }

  let msg = `✅ **${type}** sent for **${target.name}**.${extra}`;
  if (note) msg += `\n${note}`;
  if (!logged) msg += `\n⚠️ I couldn't post to #${LOG_CHANNEL_NAME}. Check the channel exists and I can send messages there.`;
  await i.editReply({ content: msg, embeds: [embed] });
}

async function showWarnings(i) {
  const target = await lookup(i);
  if (!target) return;
  const list = db.warnings[String(target.id)] || [];
  if (!list.length) return i.editReply(`**${target.name}** has no recorded warnings.`);

  const lines = list.slice(-10).reverse().map((w, idx) =>
    `**${list.length - idx}.** <t:${w.time}:d> — ${w.reason} _(by ${w.by}, ${w.source})_${isActiveWarning(w) ? "" : " ~~expired~~"}`
  );
  const embed = new EmbedBuilder()
    .setTitle(`Warnings for ${target.name}`)
    .setDescription(lines.join("\n").slice(0, 4000))
    .setFooter({ text: `${list.length} total · ${list.filter(isActiveWarning).length} active${warningExpiryDays > 0 ? ` (warnings expire after ${warningExpiryDays} days)` : ""} · showing the latest ${Math.min(10, list.length)}` })
    .setColor(0xfee75c);
  await i.editReply({ embeds: [embed] });
}

async function clearWarnings(i) {
  const target = await lookup(i);
  if (!target) return;
  const had = (db.warnings[String(target.id)] || []).length;
  delete db.warnings[String(target.id)];
  saveDb();
  const embed = buildLogEmbed({
    source: "Discord", type: "Warnings Cleared", target,
    moderator: `${i.user.tag} (${i.user.id})`, details: `Removed ${had} warning(s)`,
  });
  await sendLog(embed);
  await i.editReply(`Cleared ${had} warning(s) for **${target.name}**.`);
}

async function broadcast(i) {
  const isAnnounce = i.commandName === "announce";
  const text = i.options.getString(isAnnounce ? "message" : "text");
  await sendToGame({ action: i.commandName, [isAnnounce ? "message" : "text"]: text, moderator: i.user.username });
  const embed = buildLogEmbed({
    source: "Discord",
    type: isAnnounce ? "Announcement" : "Protocol Set",
    moderator: `${i.user.tag} (${i.user.id})`,
    details: text,
  });
  const logged = await sendLog(embed);
  await i.editReply({
    content: `✅ ${isAnnounce ? "Announcement" : "Protocol"} sent to all game servers.` +
      (logged ? "" : `\n⚠️ Couldn't post to #${LOG_CHANNEL_NAME}.`),
    embeds: [embed],
  });
}

async function whois(i) {
  const member = i.options.getUser("member");
  const uname = i.options.getString("username");
  if (member) {
    const link = db.links[member.id];
    return i.editReply(
      link ? `<@${member.id}> is linked to **${link.name}** (${link.id}).` : `<@${member.id}> hasn't linked a Roblox account.`
    );
  }
  if (uname) {
    const user = await getUser(uname);
    if (!user) return i.editReply(`Couldn't find a Roblox user named **${uname}**.`);
    const discordId = linkedDiscordId(user.id);
    return i.editReply(
      discordId ? `**${user.name}** is linked to <@${discordId}>.` : `**${user.name}** isn't linked to any Discord account.`
    );
  }
  return i.editReply("Give me a Discord member or a Roblox username.");
}

// ---------- Promote / demote ----------
// The game works out the next rank (it knows each branch's rank ladder), applies it, and
// writes the result to the queue under "res_<requestId>". We wait for that reply here.
async function waitForResult(requestId, timeoutMs) {
  const q = `datastoreName=${LOG_STORE}&entryKey=res_${requestId}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${dsBase()}/entry?${q}`, { headers: robloxHeaders }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      await fetch(`${dsBase()}/entry?${q}`, { method: "DELETE", headers: robloxHeaders }).catch(() => {});
      return data;
    }
  }
  // Late replies get cleaned up so they don't pile up
  setTimeout(() => {
    fetch(`${dsBase()}/entry?${q}`, { method: "DELETE", headers: robloxHeaders }).catch(() => {});
  }, 60000);
  return null;
}

// Asks the game to move a player up or down their rank track. Returns the game's reply, or null.
async function stepRankRequest({ targetId, direction, steps = 1, reason, moderatorName }) {
  const requestId = crypto.randomBytes(8).toString("hex");
  await sendToGame({
    action: direction > 0 ? "promote" : "demote", userId: targetId, steps, requestId, reason, moderator: moderatorName,
  });
  return waitForResult(requestId, 20000);
}

async function promoteDemote(i) {
  const promoting = i.commandName === "promote";
  const target = await lookup(i);
  if (!target) return;

  const steps = i.options.getInteger("steps") ?? 1;
  const reason = i.options.getString("reason");
  const modTag = `${i.user.tag} (${i.user.id})`;
  await i.editReply(`⏳ ${promoting ? "Promoting" : "Demoting"} **${target.name}**... waiting for the game to confirm.`);
  const result = await stepRankRequest({
    targetId: target.id, direction: promoting ? 1 : -1, steps, reason, moderatorName: i.user.username,
  });
  if (!result) {
    return i.editReply(
      `I didn't hear back from the game. **${target.name}** needs to be in the game right now for ${i.commandName}s to work, and the game must be published with the latest DiscordBridge script.`
    );
  }
  if (!result.ok) return i.editReply(`❌ ${result.message}`);

  const change = `${result.oldName} (${result.oldCode}) → ${result.newName} (${result.newCode})`;
  const embed = buildLogEmbed({
    source: "Discord", type: promoting ? "Promotion" : "Demotion", target, moderator: modTag, reason, details: change,
  });
  const logged = await sendLog(embed);
  addRankHistory(target.id, { type: promoting ? "Promotion" : "Demotion", change, by: modTag, source: "Discord" });
  scheduleAutoSync(target.id, 6000); // update their Discord nickname and roles shortly after

  await dmPlayer(target.id, {
    embeds: [
      notice(
        promoting ? "You were promoted!" : "You were demoted",
        `You are now **${result.newName}**.` + (reason ? `\n**Note:** ${reason}` : ""),
        promoting ? 0x57f287 : 0xed4245
      ),
    ],
  });

  await i.editReply({
    content: `✅ ${promoting ? "Promoted" : "Demoted"} **${target.name}**: ${change}` +
      (logged ? "" : `\n⚠️ I couldn't post to #${LOG_CHANNEL_NAME}.`),
    embeds: [embed],
  });
}

// ---------- Two-way bans (opt-in with TWO_WAY_BANS=true) ----------
// A game ban also bans the player's linked Discord account (and the reverse). Staff are skipped.
async function mirrorGameBan(action, robloxTarget, reason, modTag) {
  if (!TWO_WAY) return null;
  const discordId = linkedDiscordId(robloxTarget.id);
  if (!discordId) return null;
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  try {
    if (action === "ban") {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (member && (isAdminLike(member) || !member.bannable)) return "Their linked Discord account was NOT banned (staff, or I can't ban them).";
      await guild.members.ban(discordId, { reason: `Mirrored game ban: ${reason}`.slice(0, 500) });
      addDmLog(discordId, { type: "Ban", reason: `Mirrored from game ban: ${reason}`, by: modTag });
      return "Their linked Discord account was banned too.";
    }
    await guild.members.unban(discordId, "Mirrored game unban");
    return "Their linked Discord account was unbanned too.";
  } catch (e) {
    return `Couldn't mirror to Discord: ${e.message}`;
  }
}

async function mirrorDiscordBan(action, discordUser, reason, modTag) {
  if (!TWO_WAY) return null;
  const link = db.links[discordUser.id];
  if (!link) return null;
  try {
    if (action === "ban") {
      await sendToGame({ action: "ban", userId: link.id, duration: -1, reason: `Banned from Discord: ${reason}`, moderator: modTag });
      db.bans[String(link.id)] = { name: link.name, reason: `Banned from Discord: ${reason}`, by: modTag, time: nowUnix(), length: "Permanent" };
    } else {
      await sendToGame({ action: "unban", userId: link.id, reason: "Unbanned from Discord", moderator: modTag });
      delete db.bans[String(link.id)];
    }
    saveDb();
    return `Their linked Roblox account (${link.name}) was ${action === "ban" ? "banned" : "unbanned"} in the game too.`;
  } catch (e) {
    return `Couldn't mirror to the game: ${e.message}`;
  }
}

// ---------- Discord server moderation (/dmod) ----------
function addDmLog(userId, entry) {
  (db.dmlogs[userId] ||= []).push({ ...entry, time: nowUnix() });
  saveDb();
}

function hierarchyBlock(i, member) {
  if (member.id === i.guild.ownerId) return "You can't moderate the server owner.";
  if (i.user.id !== i.guild.ownerId && i.member.roles.highest.position <= member.roles.highest.position) {
    return "You can only moderate members whose highest role is below yours.";
  }
  return null;
}

async function dmod(i) {
  const sub = i.options.getSubcommand();
  const guild = i.guild;
  const modTag = `${i.user.tag} (${i.user.id})`;

  // ----- purge (no target user) -----
  if (sub === "purge") {
    const amount = i.options.getInteger("amount");
    const deleted = await i.channel.bulkDelete(amount, true);
    const embed = buildLogEmbed({
      source: "Discord", type: "Messages Purged", moderator: modTag,
      details: `${deleted.size} message(s) deleted in <#${i.channel.id}>`,
    });
    await sendLog(embed);
    return i.editReply(`🧹 Deleted ${deleted.size} message(s). (Messages older than 14 days can't be bulk deleted.)`);
  }

  const user = i.options.getUser("user");
  const reason = i.options.getString("reason") || "No reason provided";
  const target = { name: user.tag, id: user.id };

  if (user.id === i.user.id) return i.editReply("You can't do that to yourself.");
  if (user.id === client.user.id) return i.editReply("Nice try.");
  if (user.bot && sub !== "history" && sub !== "unban") {
    // allowed, but hierarchy rules below still apply
  }

  // ----- history / clearhistory -----
  if (sub === "history") {
    const list = db.dmlogs[user.id] || [];
    if (!list.length) return i.editReply(`**${user.tag}** has a clean record.`);
    const count = (t) => list.filter((e) => e.type === t).length;
    const lines = list.slice(-15).reverse().map(
      (e) => `<t:${e.time}:d> **${e.type}** — ${e.reason}${e.details ? ` (${e.details})` : ""} _(by ${e.by})_`
    );
    const embed = new EmbedBuilder()
      .setTitle(`Moderation history: ${user.tag}`)
      .setColor(0xfee75c)
      .setDescription(lines.join("\n").slice(0, 4000))
      .setFooter({
        text: `Warns ${count("Warn")} · Strikes ${count("Strike")} · Timeouts ${count("Timeout")} · Kicks ${count("Kick")} · Bans ${count("Ban")} · showing latest 15`,
      });
    return i.editReply({ embeds: [embed] });
  }
  if (sub === "clearhistory") {
    const had = (db.dmlogs[user.id] || []).length;
    delete db.dmlogs[user.id];
    saveDb();
    await sendLog(buildLogEmbed({
      source: "Discord", type: "Member History Cleared", target, targetLabel: "Member",
      moderator: modTag, details: `Removed ${had} entr${had === 1 ? "y" : "ies"}`,
    }));
    return i.editReply(`Cleared ${had} entr${had === 1 ? "y" : "ies"} for **${user.tag}**.`);
  }

  // ----- actions that may need the member in the server -----
  const needsMember = ["kick", "timeout", "untimeout"].includes(sub);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (needsMember && !member) return i.editReply("That user isn't in this server.");
  if (member) {
    const blocked = hierarchyBlock(i, member);
    if (blocked) return i.editReply(blocked);
  }

  const dmUser = (title, text, color) =>
    dmDiscord(user.id, { embeds: [notice(title, `${text}\n**Server:** ${guild.name}`, color)] });
  const auditReason = `${reason} (by ${i.user.tag})`.slice(0, 500);
  let type, details, record, extra = "";

  switch (sub) {
    case "kick":
      if (!member.kickable) return i.editReply("I can't kick that member (their role is above mine, or I lack the permission).");
      await dmUser("You were kicked from the server", `**Reason:** ${reason}`);
      await member.kick(auditReason);
      type = "Member Kick";
      record = "Kick";
      break;

    case "ban": {
      if (member && !member.bannable) return i.editReply("I can't ban that member (their role is above mine, or I lack the permission).");
      const days = i.options.getInteger("delete_days") ?? 0;
      await dmUser("You were banned from the server", `**Reason:** ${reason}`);
      await guild.members.ban(user.id, { deleteMessageSeconds: days * 86400, reason: auditReason });
      type = "Member Ban";
      record = "Ban";
      details = days ? `Deleted ${days} day(s) of messages` : undefined;
      break;
    }

    case "unban":
      try {
        await guild.members.unban(user.id, auditReason);
      } catch {
        return i.editReply("That user isn't banned (or I can't unban them).");
      }
      type = "Member Unban";
      record = "Unban";
      break;

    case "timeout": {
      if (!member.moderatable) return i.editReply("I can't timeout that member (their role is above mine, or I lack the permission).");
      const minutes = i.options.getInteger("minutes");
      await dmUser("You were timed out", `**Reason:** ${reason}\n**Length:** ${fmtMinutes(minutes)}`);
      await member.timeout(minutes * 60 * 1000, auditReason);
      type = "Member Timeout";
      record = "Timeout";
      details = `Length: ${fmtMinutes(minutes)}`;
      break;
    }

    case "untimeout":
      if (!member.moderatable) return i.editReply("I can't change that member's timeout.");
      await member.timeout(null, auditReason);
      type = "Member Timeout Removed";
      break;

    case "warn":
      await dmUser("You received a warning", `**Reason:** ${reason}`);
      type = "Member Warning";
      record = "Warn";
      break;

    case "strike": {
      await dmUser("You received a strike", `**Reason:** ${reason}`);
      type = "Member Strike";
      record = "Strike";
      break;
    }
  }

  if (record) addDmLog(user.id, { type: record, reason, by: i.user.tag, details });

  if (sub === "ban" || sub === "unban") {
    const mirrored = await mirrorDiscordBan(sub, user, reason, modTag);
    if (mirrored) extra += `\n🔁 ${mirrored}`;
  }

  // Strike auto-ban
  if (sub === "strike") {
    const strikes = (db.dmlogs[user.id] || []).filter((e) => e.type === "Strike").length;
    extra = `\nThis is strike **#${strikes}**.`;
    if (strikeBanAt > 0 && strikes >= strikeBanAt) {
      try {
        await dmUser("You were banned from the server", `Reached ${strikes} strikes.`);
        await guild.members.ban(user.id, { reason: `Auto-ban: ${strikes} strikes` });
        addDmLog(user.id, { type: "Ban", reason: `Auto-ban: ${strikes} strikes`, by: "Auto-moderation" });
        await sendLog(buildLogEmbed({
          source: "Discord", type: "Member Ban (Auto)", target, targetLabel: "Member",
          moderator: "Auto-moderation", reason: `Reached ${strikes} strikes`,
        }));
        extra += " They were auto-banned.";
      } catch (e) {
        extra += ` Auto-ban failed: ${e.message}`;
      }
    }
  }

  const embed = buildLogEmbed({
    source: "Discord", type, target, targetLabel: "Member", moderator: modTag,
    reason: sub === "untimeout" ? null : reason, details,
  });
  const logged = await sendLog(embed);
  await i.editReply({
    content: `✅ **${type}** done for **${user.tag}**.${extra}` +
      (logged ? "" : `\n⚠️ I couldn't post to #${LOG_CHANNEL_NAME}.`),
    embeds: [embed],
  });
}

// ---------- Roles: /addrole, /removerole, /permission ----------
function roleProblem(role) {
  if (!role) return "I couldn't find that role.";
  if (role.id === role.guild.id) return "You can't use @everyone.";
  if (role.managed) return "That role is managed by an integration or bot, so it can't be given.";
  if (role.permissions.any(DANGEROUS_PERMS)) {
    return "That role has powerful permissions (admin, moderation or management). The bot never hands those out.";
  }
  if (!role.editable) return "I can't manage that role. Move my bot role above it in Server Settings → Roles, and make sure I have Manage Roles.";
  return null;
}

function canManageRole(member, role) {
  return isAdmin(member) || hasRole(member, ROLE_MANAGER_ROLE_ID) ||
    (db.perms[member.id]?.roles || []).includes(role.id);
}

async function roleCommand(i) {
  const adding = i.commandName === "addrole";
  const user = i.options.getUser("member");
  const role = await i.guild.roles.fetch(i.options.getRole("role").id).catch(() => null);
  if (!role) return i.editReply("I couldn't find that role.");

  if (!canManageRole(i.member, role)) {
    return i.editReply(
      `You don't have permission to ${adding ? "give" : "remove"} **${role.name}**. ` +
      "Ask a role manager or administrator to grant you access with `/permission grant`."
    );
  }
  const problem = roleProblem(role);
  if (problem) return i.editReply(problem);

  const member = await i.guild.members.fetch(user.id).catch(() => null);
  if (!member) return i.editReply("That user isn't in this server.");
  if (adding && member.roles.cache.has(role.id)) return i.editReply(`${user.tag} already has **${role.name}**.`);
  if (!adding && !member.roles.cache.has(role.id)) return i.editReply(`${user.tag} doesn't have **${role.name}**.`);

  const reason = `${adding ? "Added" : "Removed"} by ${i.user.tag}`;
  if (adding) await member.roles.add(role, reason);
  else await member.roles.remove(role, reason);

  const embed = buildLogEmbed({
    source: "Discord", type: adding ? "Role Added" : "Role Removed",
    target: { name: user.tag, id: user.id }, targetLabel: "Member",
    moderator: `${i.user.tag} (${i.user.id})`, details: `Role: ${role.name}`,
  });
  await sendLog(embed);
  await i.editReply(`✅ ${adding ? "Gave" : "Removed"} **${role.name}** ${adding ? "to" : "from"} ${user.tag}.`);
}

function permissionChoices(query) {
  const q = (query || "").toLowerCase();
  const items = [
    ...Object.entries(PRESETS).map(([key, p]) => ({
      name: `preset: ${key} — ${p.desc}`.slice(0, 100), value: `preset:${key}`, search: `preset ${key} ${p.desc}`,
    })),
    ...Object.entries(PERMISSIONS).filter(([, d]) => !d.locked).map(([key, d]) => ({
      name: `${key} — ${d.desc}`.slice(0, 100), value: key, search: `${key} ${d.desc} ${d.group}`,
    })),
  ];
  return items.filter((x) => x.search.toLowerCase().includes(q)).slice(0, 25).map(({ name, value }) => ({ name, value }));
}

async function onAutocomplete(i) {
  if (i.commandName === "permission") {
    const focused = i.options.getFocused(true);
    if (focused.name === "permission") return i.respond(permissionChoices(focused.value));
  }
  return i.respond([]);
}

function describeGrants(userId) {
  const entry = db.perms[userId];
  const nodes = Object.entries(entry?.nodes || {}).filter(([, exp]) => exp === null || exp > nowUnix());
  const lines = nodes.map(([n, exp]) => `• **${n}**${exp ? ` (until <t:${exp}:d>)` : ""}`);
  const roles = (entry?.roles || []).map((id) => `<@&${id}>`).join(", ");
  if (roles) lines.push(`• Can give roles: ${roles}`);
  if (entry?.backgroundcheck) lines.push("• **backgroundcheck** (from an older version)");
  return lines.join("\n") || "Nothing granted.";
}

async function permissionCommand(i) {
  const sub = i.options.getSubcommand();

  if (sub === "presets") {
    const embed = new EmbedBuilder().setTitle("Permission presets").setColor(0x5865f2)
      .setDescription("Use `/permission grant` and pick `preset: name`. Administrators always have everything.");
    for (const [key, p] of Object.entries(PRESETS)) {
      embed.addFields({ name: `${key} — ${p.desc}`, value: [...new Set(p.nodes)].join(", ").slice(0, 1024) });
    }
    return i.editReply({ embeds: [embed] });
  }
  if (sub === "mine") {
    if (isAdminLike(i.member)) return i.editReply("You're an administrator (or the server owner), so you can use everything.");
    return i.editReply({ content: `**Your permissions**\n${describeGrants(i.user.id)}`, allowedMentions: { parse: [] } });
  }

  if (!isRoleManager(i.member)) return i.editReply("Only administrators and role managers can use this.");
  const user = i.options.getUser("member");
  const modTag = `${i.user.tag} (${i.user.id})`;
  const target = { name: user.tag, id: user.id };

  if (sub === "list") {
    return i.editReply({
      content: `**${user.tag}**\n${isAdminLike(await i.guild.members.fetch(user.id).catch(() => null)) ? "Administrator: has everything.\n" : ""}${describeGrants(user.id)}`,
      allowedMentions: { parse: [] },
    });
  }

  // ----- grant / revoke -----
  const granting = sub === "grant";
  const perm = i.options.getString("permission").toLowerCase();
  const isRoleGrant = perm === "addrole";
  if (!isAdminLike(i.member) && !(isRoleGrant && isRoleManager(i.member))) {
    return i.editReply("Only administrators can grant or revoke that. Role managers can only handle `addrole`.");
  }
  if (user.bot) return i.editReply("Bots can't be given permissions.");

  const entry = (db.perms[user.id] ||= {});
  entry.nodes ||= {};
  entry.roles ||= [];
  const days = i.options.getInteger("days");
  const expires = days ? nowUnix() + days * 86400 : null;
  let details;

  if (isRoleGrant) {
    const picked = i.options.getRole("role");
    if (granting) {
      if (!picked) return i.editReply("Pick which role they're allowed to give.");
      const role = await i.guild.roles.fetch(picked.id).catch(() => null);
      const problem = roleProblem(role);
      if (problem) return i.editReply(problem);
      if (!entry.roles.includes(role.id)) entry.roles.push(role.id);
      details = `Granted: can give role "${role.name}"`;
    } else if (picked) {
      entry.roles = entry.roles.filter((id) => id !== picked.id);
      details = `Revoked: can give role "${picked.name}"`;
    } else {
      entry.roles = [];
      details = "Revoked: can give any role";
    }
  } else {
    let nodes;
    if (perm.startsWith("preset:")) {
      const preset = PRESETS[perm.slice(7)];
      if (!preset) return i.editReply("I don't know that preset. Use `/permission presets` to see them.");
      nodes = [...new Set(preset.nodes)];
    } else {
      if (!PERMISSIONS[perm]) return i.editReply("I don't know that permission. Start typing and pick one from the list.");
      if (PERMISSIONS[perm].locked) return i.editReply("That permission is admin-only and can't be granted.");
      nodes = [perm];
    }
    for (const node of nodes) {
      if (granting) entry.nodes[node] = expires;
      else delete entry.nodes[node];
    }
    details = `${granting ? "Granted" : "Revoked"}: ${perm.startsWith("preset:") ? `preset "${perm.slice(7)}" (${nodes.length} permissions)` : perm}` +
      (granting && expires ? ` until <t:${expires}:f>` : "");
  }
  saveDb();

  await sendLog(buildLogEmbed({
    source: "Discord", type: granting ? "Permission Granted" : "Permission Revoked",
    target, targetLabel: "Member", moderator: modTag, byLabel: "Changed by", details,
  }));
  await i.editReply(`✅ ${details} for ${user.tag}.`);
}

// ---------- Creating and editing roles (admins only) ----------
const COLOR_NAMES = {
  red: 0xe74c3c, orange: 0xe67e22, yellow: 0xf1c40f, gold: 0xf1c40f, green: 0x2ecc71, lime: 0x7bed9f,
  teal: 0x1abc9c, cyan: 0x00cec9, blue: 0x3498db, navy: 0x1f3a93, purple: 0x9b59b6, pink: 0xe91e8c,
  brown: 0x8d6e63, white: 0xffffff, black: 0x010101, gray: 0x95a5a6, grey: 0x95a5a6,
};
const COLOR_HELP =
  "I couldn't read that color. Use a hex code like `#ff0000`, or a name: " + Object.keys(COLOR_NAMES).join(", ") + ".";

// Returns a number, null (no color given / 'none'), or undefined (invalid)
function parseColor(input) {
  if (input === null || input === undefined || input.trim() === "") return null;
  const s = input.trim().toLowerCase().replace(/^#/, "");
  if (s === "none" || s === "default") return 0;
  if (COLOR_NAMES[s] !== undefined) return COLOR_NAMES[s];
  if (/^[0-9a-f]{6}$/.test(s)) return parseInt(s, 16);
  if (/^[0-9a-f]{3}$/.test(s)) return parseInt([...s].map((c) => c + c).join(""), 16);
  return undefined;
}

const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;

async function createRoleCommand(i) {
  const name = i.options.getString("name").trim();
  const colorInput = i.options.getString("color");
  const color = parseColor(colorInput);
  if (color === undefined) return i.editReply(COLOR_HELP);

  await i.guild.roles.fetch();
  if (i.guild.roles.cache.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    return i.editReply(`A role called **${name}** already exists. Use \`/editrole\` to change it.`);
  }

  const role = await i.guild.roles.create({
    name,
    color: color ?? 0,
    hoist: i.options.getBoolean("hoist") ?? false,
    mentionable: i.options.getBoolean("mentionable") ?? false,
    permissions: [], // roles made by the bot never have permissions
    reason: `Created by ${i.user.tag}`,
  });

  await sendLog(buildLogEmbed({
    source: "Discord", type: "Role Created", moderator: `${i.user.tag} (${i.user.id})`,
    details: `Role: ${role.name} · Color: ${role.color ? hex(role.color) : "default"}`,
  }));
  const embed = new EmbedBuilder()
    .setColor(role.color || 0x95a5a6)
    .setTitle("Role created")
    .setDescription(`<@&${role.id}>\nColor: ${role.color ? hex(role.color) : "default"}\nIt has **no permissions**. It sits at the bottom of the role list, so drag it where you want it.`);
  await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function editRoleCommand(i) {
  const role = await i.guild.roles.fetch(i.options.getRole("role").id).catch(() => null);
  if (!role || role.id === i.guild.id) return i.editReply("I can't edit that role.");
  if (role.managed) return i.editReply("That role is managed by a bot or integration, so it can't be edited.");
  if (!role.editable) {
    return i.editReply("I can't edit that role. Move my bot role above it in Server Settings → Roles, and make sure I have Manage Roles.");
  }

  const newName = i.options.getString("name")?.trim();
  const colorInput = i.options.getString("color");
  const color = parseColor(colorInput);
  if (color === undefined) return i.editReply(COLOR_HELP);
  const hoist = i.options.getBoolean("hoist");
  const mentionable = i.options.getBoolean("mentionable");

  const changes = {};
  const notes = [];
  if (newName) { changes.name = newName; notes.push(`Name: ${role.name} → ${newName}`); }
  if (color !== null) {
    changes.color = color;
    notes.push(`Color: ${role.color ? hex(role.color) : "default"} → ${color ? hex(color) : "default"}`);
  }
  if (hoist !== null) { changes.hoist = hoist; notes.push(`Shown separately: ${hoist ? "yes" : "no"}`); }
  if (mentionable !== null) { changes.mentionable = mentionable; notes.push(`Mentionable: ${mentionable ? "yes" : "no"}`); }
  if (!notes.length) return i.editReply("Tell me what to change: a new name, color, hoist or mentionable.");

  const updated = await role.edit({ ...changes, reason: `Edited by ${i.user.tag}` });
  await sendLog(buildLogEmbed({
    source: "Discord", type: "Role Edited", moderator: `${i.user.tag} (${i.user.id})`,
    details: `Role: ${updated.name}\n${notes.join("\n")}`,
  }));
  const embed = new EmbedBuilder()
    .setColor(updated.color || 0x95a5a6)
    .setTitle("Role updated")
    .setDescription(`<@&${updated.id}>\n${notes.join("\n")}`);
  await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

// ---------- Background check ----------
async function backgroundCheck(i) {
  const user = await getUser(i.options.getString("username"));
  if (!user) return i.editReply(`Couldn't find a Roblox user named **${i.options.getString("username")}**.`);
  const id = user.id;

  const get = (url) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });
  const [profileR, friendsR, followersR, followingR, namesR, groupsR, thumbR, snapR] = await Promise.allSettled([
    get(`https://users.roblox.com/v1/users/${id}`),
    get(`https://friends.roblox.com/v1/users/${id}/friends/count`),
    get(`https://friends.roblox.com/v1/users/${id}/followers/count`),
    get(`https://friends.roblox.com/v1/users/${id}/followings/count`),
    get(`https://users.roblox.com/v1/users/${id}/username-history?limit=10&sortOrder=Desc`),
    get(`https://groups.roblox.com/v2/users/${id}/groups/roles`),
    get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png`),
    getRankSnapshot(id),
  ]);
  const val = (r) => (r.status === "fulfilled" ? r.value : null);

  const profile = val(profileR);
  const createdUnix = profile?.created ? Math.floor(Date.parse(profile.created) / 1000) : null;
  const ageDays = createdUnix ? Math.floor((nowUnix() - createdUnix) / 86400) : null;
  const friends = val(friendsR)?.count;
  const followers = val(followersR)?.count;
  const following = val(followingR)?.count;
  const pastNames = (val(namesR)?.data || []).map((n) => n.name);
  const groups = val(groupsR)?.data || [];
  const thumb = val(thumbR)?.data?.[0]?.imageUrl;
  const snap = val(snapR);

  const warns = db.warnings[String(id)] || [];
  const ban = db.bans[String(id)];
  const appeal = db.appeals[String(id)];
  const discordId = linkedDiscordId(id);
  const notes = db.notes[String(id)] || [];
  const act = db.activity[String(id)];
  const hours7 = Math.round((activitySeconds(id, 7) / 3600) * 10) / 10;

  const flags = [];
  if (profile?.isBanned) flags.push("🚩 Banned on Roblox");
  if (ageDays !== null && ageDays < 30) flags.push(`🚩 New account (${ageDays} day${ageDays === 1 ? "" : "s"} old)`);
  if (pastNames.length >= 3) flags.push(`🚩 Changed username ${pastNames.length} times`);
  if (ban) flags.push("🚩 Banned by staff before");
  if (warns.length >= 3) flags.push(`🚩 ${warns.length} warnings on record`);
  if (friends === 0) flags.push("⚠️ No friends");

  const embed = new EmbedBuilder()
    .setTitle(`Background check: ${user.name}`)
    .setURL(`https://www.roblox.com/users/${id}/profile`)
    .setColor(flags.some((f) => f.startsWith("🚩")) ? 0xed4245 : 0x57f287)
    .addFields(
      {
        name: "Account",
        value: [
          `**ID:** ${id}`,
          `**Display name:** ${profile?.displayName ?? "?"}`,
          createdUnix ? `**Created:** <t:${createdUnix}:D> (<t:${createdUnix}:R>)` : "**Created:** unavailable",
          `**Roblox status:** ${profile?.isBanned ? "Banned" : "Active"}`,
        ].join("\n"),
      },
      {
        name: "Social",
        value: `Friends **${friends ?? "?"}** · Followers **${followers ?? "?"}** · Following **${following ?? "?"}**`,
      },
      { name: "Past usernames", value: pastNames.length ? pastNames.join(", ").slice(0, 1024) : "None" },
      {
        name: `Groups (${groups.length})`,
        value: groups.length
          ? groups.slice(0, 8).map((g) => `${g.group.name} — ${g.role.name}`).join("\n").slice(0, 900) +
            (groups.length > 8 ? `\n…and ${groups.length - 8} more` : "")
          : "None",
      },
      {
        name: "In-game (last known)",
        value: snap
          ? `**Rank:** ${snap.rankName} (${snap.rankCode})\n**Branch:** ${snap.branchName ?? "None"}\n**Last updated:** <t:${snap.time}:R>`
          : "No rank on record.",
      },
      {
        name: "Discord",
        value: discordId ? `Linked to <@${discordId}>` : "Not linked to a Discord account",
      },
      {
        name: "Staff records",
        value: [
          `**Warnings:** ${warns.length}${warns.length ? ` (latest: ${warns[warns.length - 1].reason})` : ""}`,
          `**Ban on record:** ${ban ? `${ban.reason} · ${ban.length} · <t:${ban.time}:d>` : "None"}`,
          `**Open appeal:** ${appeal ? "Yes" : "No"}`,
        ].join("\n").slice(0, 1024),
      },
      {
        name: "Notes & activity",
        value: [
          `**Staff notes:** ${notes.length}${notes.length ? ` (latest: ${notes[notes.length - 1].text.slice(0, 100)})` : ""}`,
          act ? `**Playtime (7 days):** ${hours7}h · **Last seen:** <t:${act.lastSeen}:R>` : "**Playtime:** not tracked yet",
        ].join("\n").slice(0, 1024),
      },
      { name: "Flags", value: flags.length ? flags.join("\n") : "✅ Nothing stands out" }
    )
    .setFooter({ text: "Based on public Roblox data and this bot's records" })
    .setTimestamp();
  if (thumb) embed.setThumbnail(thumb);
  const bio = (profile?.description || "").replace(/`/g, "'").trim();
  if (bio) embed.setDescription(`> ${bio.slice(0, 250).replace(/\n/g, " ")}`);

  await sendLog(buildLogEmbed({
    source: "Discord", type: "Background Check", target: { name: user.name, id },
    moderator: `${i.user.tag} (${i.user.id})`, byLabel: "Run by",
  }));
  await i.editReply({ embeds: [embed] });
}

// ---------- Account linking ----------
const WORDS = ["apple", "river", "cloud", "tiger", "maple", "ocean", "stone", "eagle", "lemon", "piano", "comet", "forest"];
function makePhrase() {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${pick()} ${pick()} ${pick()} ${pick()}`;
}

async function startVerify(i) {
  return beginVerify(i, i.options.getString("username"));
}

// i must already be deferred (ephemeral). Used by /verify and by the verify panel button.
async function beginVerify(i, uname) {
  const existingLink = db.links[i.user.id];
  if (existingLink) {
    return i.editReply(
      `You're already verified as **${existingLink.name}**. ✅\n` +
      "Run `/update` to refresh your nickname and rank/branch roles, or `/unlink` first if you want to link a different account."
    );
  }

  const user = await getUser(uname);
  if (!user) return i.editReply(`Couldn't find a Roblox user named **${uname}**.`);

  const existing = linkedDiscordId(user.id);
  if (existing && existing !== i.user.id) {
    return i.editReply("That Roblox account is already linked to a different Discord account. Ask a moderator for help.");
  }

  const phrase = makePhrase();
  pendingLinks.set(i.user.id, { id: user.id, name: user.name, phrase, expires: Date.now() + 15 * 60 * 1000 });

  const embed = new EmbedBuilder()
    .setTitle(`Link ${user.name}`)
    .setColor(0x5865f2)
    .setDescription(
      "To prove this account is yours:\n" +
      "1. Go to your Roblox profile and edit your **About** section.\n" +
      `2. Paste this phrase anywhere in it:\n\`\`\`${phrase}\`\`\`\n` +
      "3. Save, then press the button below. You can delete the phrase afterwards.\n\n" +
      "This expires in 15 minutes."
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("verify_check").setLabel("I've updated my profile").setStyle(ButtonStyle.Success)
  );
  await i.editReply({ embeds: [embed], components: [row] });
}

async function finishVerify(i) {
  const pend = pendingLinks.get(i.user.id);
  if (!pend || pend.expires < Date.now()) {
    return i.reply({ content: "Your verification expired. Run `/verify` again.", ...eph });
  }
  await i.deferReply(eph);
  const profile = await getProfile(pend.id);
  if (!(profile.description || "").toLowerCase().includes(pend.phrase)) {
    return i.editReply("I couldn't find the phrase on your profile yet. Make sure you saved your About section, then press the button again.");
  }
  const link = { id: pend.id, name: profile.name, at: nowUnix() };
  db.links[i.user.id] = link;
  saveDb();
  pendingLinks.delete(i.user.id);

  const result = await refreshMember(i.member, link);
  await i.editReply({
    content: `✅ Linked to **${profile.name}**. You can remove the phrase from your profile now.`,
    embeds: [updateEmbed(result, link)],
  });
}

async function unlink(i) {
  const link = db.links[i.user.id];
  if (!link) return i.editReply("You don't have a linked Roblox account.");
  for (const key of ["rankRoleId", "branchRoleId"]) {
    if (link[key] && i.member.roles.cache.has(link[key])) {
      try { await i.member.roles.remove(link[key], "Unlinked Roblox account"); } catch { /* ignore */ }
    }
  }
  delete db.links[i.user.id];
  saveDb();
  if (VERIFIED_ROLE_ID) {
    try { await i.member.roles.remove(VERIFIED_ROLE_ID); } catch { /* ignore */ }
  }
  try { await i.member.setNickname(null, "Unlinked Roblox account"); } catch { /* ignore */ }
  await i.editReply("Your Roblox account was unlinked. Your nickname and rank/branch roles were removed.");
}

const NICK_FAIL =
  "I couldn't change your nickname. Server owners and members above my role can't be renamed by bots, so you'd need to change it yourself.";

// ---------- Rank tiers, branch tags and nicknames ----------
// Which tier a rank belongs to: Enlisted, Officer, Command Staff or Senior Command
function tierOf(snap) {
  if (!snap || !snap.rankCode) return null;
  if (snap.category === "Senior Command") return "Senior Command";
  if (COMMAND_STAFF_CODES.has(snap.rankCode)) return "Command Staff";
  if (snap.category === "Enlisted") return "Enlisted";
  return "Officer"; // warrant and commissioned officers
}

// E9 -> E-9, O10 -> O-10, W2 -> W-2. Special ranks (COS, CJCS...) stay as they are.
function formatRank(code) {
  const m = /^([EWO])(\d+)$/.exec(code || "");
  return m ? `${m[1]}-${m[2]}` : code || "";
}

// e.g. "[E-9] steve [USHQ]". Long names get shortened so the tags always fit in 32 characters.
function buildNickname(name, display, snap) {
  const rank = snap?.rankCode ? formatRank(snap.rankCode) : "";
  const branch = snap?.branchCode && !HIDE_BRANCH_CODES.has(snap.branchCode) ? snap.branchCode : "";
  const render = (n, d) =>
    NICK_TEMPLATE
      .replaceAll("{rank}", rank)
      .replaceAll("{branch}", branch)
      .replaceAll("{name}", n)
      .replaceAll("{display}", d)
      .replace(/\[\s*\]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

  let n = name;
  let d = display || name;
  let out = render(n, d);
  while (out.length > 32 && (n.length > 1 || d.length > 1)) {
    const over = out.length - 32;
    n = n.slice(0, Math.max(1, n.length - over));
    d = d.slice(0, Math.max(1, d.length - over));
    out = render(n, d);
  }
  return out.slice(0, 32);
}

async function setNick(member, name, displayName, snap) {
  if (!member) return null;
  const nick = buildNickname(name, displayName, snap);
  try {
    await member.setNickname(nick, "Synced from Roblox account");
    return nick;
  } catch (e) {
    console.warn(`Couldn't set nickname for ${member.user?.tag}: ${e.message}`);
    return null;
  }
}

// ---------- Tier and branch roles ----------
async function findOrCreateRole(guild, name, color = 0) {
  await guild.roles.fetch();
  const role = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (role) return role;
  if (!AUTO_CREATE) return null;
  return guild.roles.create({
    name: name.slice(0, 100),
    color,
    permissions: [],
    mentionable: false,
    reason: "Tier/branch role created by the bot",
  });
}

// Gives the member their tier role and branch role, and removes the old ones.
// (Stored as rankRoleId / branchRoleId in data.json.)
async function syncRoles(member, link, snap) {
  const result = { added: [], removed: [], skipped: [] };
  const tier = tierOf(snap);
  const wanted = { rank: tier ? TIER_NAMES[tier] : null, branch: snap?.branchName };
  const colors = { rank: tier ? TIER_COLORS[tier] : 0, branch: 0 };

  for (const kind of ["rank", "branch"]) {
    const key = `${kind}RoleId`;
    const oldId = link[key];
    let newRole = null;

    if (wanted[kind]) {
      const role = await findOrCreateRole(member.guild, wanted[kind], colors[kind]).catch((e) => {
        console.warn(`Couldn't create role ${wanted[kind]}: ${e.message}`);
        return null;
      });
      const problem = role ? roleProblem(role) : "missing";
      if (!problem) newRole = role;
      else result.skipped.push(`${wanted[kind]} (${problem === "missing" ? "role doesn't exist" : problem})`);
    }

    if (oldId && (!newRole || newRole.id !== oldId) && member.roles.cache.has(oldId)) {
      const oldRole = member.guild.roles.cache.get(oldId);
      try {
        await member.roles.remove(oldId, "Rank/branch changed");
        if (oldRole) result.removed.push(oldRole.name);
      } catch (e) {
        console.warn(`Couldn't remove old role: ${e.message}`);
      }
    }
    if (newRole) {
      if (!member.roles.cache.has(newRole.id)) {
        try {
          await member.roles.add(newRole, "Synced from in-game rank");
          result.added.push(newRole.name);
        } catch (e) {
          result.skipped.push(`${newRole.name} (${e.message})`);
        }
      }
      link[key] = newRole.id;
    } else if (!wanted[kind]) {
      link[key] = null;
    }
  }
  return result;
}

// Nickname + verified role + tier/branch roles, all in one go
async function refreshMember(member, link) {
  const profile = await getProfile(link.id); // also picks up Roblox username changes
  link.name = profile.name;
  link.display = profile.displayName;

  let snap = null, snapError = null;
  try { snap = await getRankSnapshot(link.id); } catch (e) { snapError = e.message; }

  const nick = await setNick(member, profile.name, profile.displayName, snap);

  if (VERIFIED_ROLE_ID && !member.roles.cache.has(VERIFIED_ROLE_ID)) {
    try { await member.roles.add(VERIFIED_ROLE_ID); } catch (e) { console.warn("Couldn't add verified role:", e.message); }
  }

  const roles = snap ? await syncRoles(member, link, snap) : null;
  saveDb();
  return { profile, nick, nickOk: Boolean(nick), snap, snapError, roles };
}

function updateEmbed(r, link) {
  const embed = new EmbedBuilder().setTitle("Account updated").setColor(0x57f287);
  embed.addFields(
    { name: "Roblox account", value: `${link.name} (${link.id})`, inline: true },
    { name: "Nickname", value: r.nickOk ? `**${r.nick}**` : "Couldn't change (see below)", inline: true }
  );
  if (r.snap) {
    embed.addFields(
      { name: "Rank", value: `${r.snap.rankName} (${r.snap.rankCode})`, inline: true },
      { name: "Branch", value: r.snap.branchName || "None", inline: true }
    );
    const changes = [];
    if (r.roles.added.length) changes.push(`**Added:** ${r.roles.added.join(", ")}`);
    if (r.roles.removed.length) changes.push(`**Removed:** ${r.roles.removed.join(", ")}`);
    if (r.roles.skipped.length) changes.push(`**Couldn't give:** ${r.roles.skipped.join("; ")}`);
    embed.addFields({ name: "Roles", value: (changes.join("\n") || "Already up to date").slice(0, 1024) });
  } else if (r.snapError) {
    embed.addFields({ name: "Rank", value: `I couldn't read your rank right now (${r.snapError}). Tell a staff member.` });
  } else {
    embed.addFields({
      name: "Rank",
      value: "I don't have a rank on record for you yet. Join the game once, wait a few seconds, then run `/update` again.",
    });
  }
  if (!r.nickOk) embed.setFooter({ text: NICK_FAIL });
  return embed;
}

async function updateCommand(i) {
  const link = db.links[i.user.id];
  if (!link) return i.editReply("You haven't linked a Roblox account yet. Use `/verify` first.");
  const result = await refreshMember(i.member, link);
  await i.editReply({ embeds: [updateEmbed(result, link)] });
}

// Updates a linked member's nickname and roles without them asking (after a rank change)
function scheduleAutoSync(robloxId, delayMs) {
  setTimeout(() => autoSync(robloxId).catch((e) => console.warn("Auto-sync failed:", e.message)), delayMs);
}

async function autoSync(robloxId) {
  const discordId = linkedDiscordId(robloxId);
  if (!discordId) return;
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  const snap = await getRankSnapshot(robloxId);
  if (!snap) return;
  const link = db.links[discordId];
  await setNick(member, link.name, link.display, snap);
  await syncRoles(member, link, snap);
  saveDb();
}

// ---------- Appeals ----------
async function appealPanel(i) {
  const embed = new EmbedBuilder()
    .setTitle("Appeal a punishment")
    .setColor(0x5865f2)
    .setDescription("Think you were banned or punished unfairly? Press the button to open a private appeal with the staff.\nYou need to link your Roblox account first with `/verify`.");
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("appeal_open").setLabel("Open an appeal").setStyle(ButtonStyle.Primary)
  );
  await i.channel.send({ embeds: [embed], components: [row] });
  await i.editReply("Panel posted.");
}

async function onButton(i) {
  const [kind, a, b] = i.customId.split(":");
  switch (kind) {
    case "confirm": return handleConfirm(i, a, b);
    case "verify_check": return finishVerify(i);
    case "appeal_open": return openAppealModal(i, a, b);
    case "appeal_accept":
    case "appeal_deny":
    case "appeal_close": return appealStaffAction(i, kind, a);
    default: {
      const handler = featureButtons[kind];
      if (handler) return handler(i, ...i.customId.split(":").slice(1));
    }
  }
}

async function openAppealModal(i, robloxId, robloxName) {
  if (!robloxId) {
    const link = db.links[i.user.id];
    if (!link) {
      return i.reply({ content: "Link your Roblox account first with `/verify`, then press the button again.", ...eph });
    }
    robloxId = String(link.id);
    robloxName = link.name;
  }
  const existing = db.appeals[robloxId];
  if (existing) {
    const ch = await client.channels.fetch(existing.channelId).catch(() => null);
    if (ch) return i.reply({ content: `You already have an open appeal: <#${ch.id}>`, ...eph });
    delete db.appeals[robloxId];
    saveDb();
  }
  const modal = new ModalBuilder()
    .setCustomId(`appeal_modal:${robloxId}:${robloxName}`)
    .setTitle("Appeal your punishment")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("appeal_text")
          .setLabel("Why should this be reviewed?")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
      )
    );
  await i.showModal(modal);
}

async function onModal(i) {
  const [kind, robloxId, robloxName] = i.customId.split(":");
  if (kind !== "appeal_modal") {
    const handler = featureModals[kind];
    if (handler) return handler(i, ...i.customId.split(":").slice(1));
    return;
  }
  await i.deferReply(eph);

  const text = i.fields.getTextInputValue("appeal_text");
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const member = await guild.members.fetch(i.user.id).catch(() => null);
  if (!member) return i.editReply("You need to be in the server to open an appeal.");

  const view = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: i.user.id, allow: view },
    { id: MOD_ROLE_ID, allow: view },
    {
      id: client.user.id,
      allow: [...view, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels],
    },
  ];
  if (ADMIN_ROLE_ID && ADMIN_ROLE_ID !== MOD_ROLE_ID) overwrites.push({ id: ADMIN_ROLE_ID, allow: view });

  const channel = await guild.channels.create({
    name: `appeal-${robloxName}`.toLowerCase().slice(0, 90),
    type: ChannelType.GuildText,
    parent: APPEAL_CATEGORY_ID || undefined,
    permissionOverwrites: overwrites,
  });

  const ban = db.bans[robloxId];
  const embed = new EmbedBuilder()
    .setTitle("New appeal")
    .setColor(0xfee75c)
    .addFields(
      { name: "Roblox account", value: `${robloxName} (${robloxId})`, inline: true },
      { name: "Discord user", value: `<@${i.user.id}>`, inline: true },
      { name: "Their appeal", value: text.slice(0, 1024) }
    )
    .setTimestamp();
  if (ban) {
    embed.addFields({
      name: "Ban on record",
      value: `**Reason:** ${ban.reason}\n**Length:** ${ban.length}\n**By:** ${ban.by}\n**When:** <t:${ban.time}:F>`.slice(0, 1024),
    });
  } else {
    embed.addFields({ name: "Ban on record", value: "None saved by the bot (they may have been banned another way)." });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appeal_accept:${robloxId}`).setLabel("Accept (unban)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`appeal_deny:${robloxId}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`appeal_close:${robloxId}`).setLabel("Close").setStyle(ButtonStyle.Secondary)
  );
  await channel.send({ content: `<@${i.user.id}> <@&${MOD_ROLE_ID}>`, embeds: [embed], components: [row] });

  db.appeals[robloxId] = { channelId: channel.id, discordId: i.user.id, name: robloxName, time: nowUnix() };
  saveDb();

  await sendLog(buildLogEmbed({
    source: "Discord", type: "Appeal Opened", target: { name: robloxName, id: robloxId },
    moderator: `${i.user.tag} (${i.user.id})`, byLabel: "Opened by", details: text,
  }));
  await i.editReply(`Your appeal was opened: <#${channel.id}>`);
}

async function appealStaffAction(i, kind, robloxId) {
  const node = kind === "appeal_accept" ? "appeals.accept" : "appeals.review";
  if (!hasPerm(i.member, node)) {
    return i.reply({ content: `You don't have permission to do that (needs **${node}**).`, ...eph });
  }
  await i.deferReply();

  const appeal = db.appeals[robloxId];
  const name = appeal?.name || "that player";
  const staff = `${i.user.tag} (${i.user.id})`;
  let verb = "closed";

  if (kind === "appeal_accept") {
    verb = "accepted";
    await sendToGame({ action: "unban", userId: Number(robloxId), reason: "Appeal accepted", moderator: i.user.username });
    delete db.bans[robloxId];
    await sendLog(buildLogEmbed({
      source: "Discord", type: "Appeal Accepted", target: { name, id: robloxId }, moderator: staff,
      byLabel: "Reviewed by", details: "The player was unbanned.",
    }));
    if (appeal) await dmDiscord(appeal.discordId, { embeds: [notice("Your appeal was accepted", "You've been unbanned and can rejoin the game.", 0x57f287)] });
  } else if (kind === "appeal_deny") {
    verb = "denied";
    await sendLog(buildLogEmbed({
      source: "Discord", type: "Appeal Denied", target: { name, id: robloxId }, moderator: staff, byLabel: "Reviewed by",
    }));
    if (appeal) await dmDiscord(appeal.discordId, { embeds: [notice("Your appeal was denied", "Staff reviewed your appeal and the punishment stays.")] });
  }

  delete db.appeals[robloxId];
  saveDb();
  await i.editReply(`Appeal ${verb} by ${i.user.tag}. This channel will be deleted in 10 seconds.`);
  setTimeout(() => i.channel.delete().catch(() => {}), 10000);
}

// ---------- Feature files (features/*.js) ----------
const featureCommands = {};
const featureButtons = {};
const featureModals = {};
const features = [];

const ctx = {
  client, db, saveDb, events, eph, crypto, nowUnix,
  config: {
    DISCORD_GUILD_ID, MOD_ROLE_ID, ADMIN_ROLE_ID, ROLE_MANAGER_ROLE_ID, VERIFIED_ROLE_ID, APPEAL_CATEGORY_ID,
    LOG_CHANNEL_NAME, DATA_DIR, DB_PATH, alertIds, autoKickAt, warningExpiryDays,
  },
  hasRole, isAdmin, isMod, isRoleManager, isAdminLike, hasPerm, PERMISSIONS, PRESETS,
  getUser, getProfile, lookup, sendToGame, waitForResult, stepRankRequest, dsBase, robloxHeaders, LOG_STORE,
  getRankSnapshot, buildLogEmbed, sendLog, notice, dmDiscord, dmPlayer, dmAlerts, linkedDiscordId,
  processWarning, addDmLog, addRankHistory, activitySeconds, isActiveWarning, formatRank, tierOf,
  scheduleAutoSync, autoSync, beginVerify, findChannelByName, roleProblem, hex, fmtMinutes,
};

function loadFeatures() {
  const dir = path.join(__dirname, "features");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
    try {
      const feature = require(path.join(dir, file))(ctx);
      features.push(feature);
      for (const builder of feature.commands || []) commands.push(builder.toJSON());
      Object.assign(featureCommands, feature.run || {});
      Object.assign(featureButtons, feature.buttons || {});
      Object.assign(featureModals, feature.modals || {});
    } catch (e) {
      console.error(`Couldn't load features/${file}:`, e);
    }
  }
}
loadFeatures();

process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
module.exports = { ctx, commands, features, nodeFor, hasPerm, PERMISSIONS, PRESETS, PUBLIC_COMMANDS, SELF_CHECKED, permissionChoices, _confirm: { needsConfirm, askConfirm, handleConfirm, pendingConfirms }, COMMAND_NODES };
client.login(DISCORD_TOKEN);