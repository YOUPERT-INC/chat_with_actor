/**
 * Saves (or removes) the verified facts about the real person behind an avatar, e.g. her
 * published books. They are added to that actress's prompt (see src/verifiedFacts.js).
 *
 *   node scripts/set-verified-facts.js <person_id> <file.txt>     save the file's text
 *   node scripts/set-verified-facts.js <person_id> --delete       remove them
 *   node scripts/set-verified-facts.js --list                     who has facts
 *   add --dry-run to check the text without saving
 *
 * Source files live in data/verified_facts/<person_id>.txt. Only put facts you have checked
 * against a real source there: the avatar will say them as her own background. The running
 * server keeps prompts for up to an hour: `pm2 restart chat-ai` afterwards to apply at once.
 */
const fs = require("fs");
const db = require("../src/db");
const { MAX_CHARS } = require("../src/verifiedFacts");

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => !a.startsWith("--"));

  if (args.includes("--list")) {
    await db.connect();
    for (const d of await db.verifiedFacts().find({}).toArray()) console.log(d.person_id, `${d.facts.length} chars`, d.updated_at);
    process.exit(0);
  }

  const [personId, file] = rest;
  if (!personId || (!file && !args.includes("--delete"))) {
    console.log("usage: set-verified-facts.js <person_id> <file.txt> | <person_id> --delete | --list [--dry-run]");
    process.exit(1);
  }

  await db.connect();
  if (args.includes("--delete")) {
    const r = await db.verifiedFacts().deleteOne({ person_id: personId });
    console.log(`${personId}: removed ${r.deletedCount}`);
    process.exit(0);
  }

  const facts = fs.readFileSync(file, "utf8").trim();
  if (!facts) throw new Error("file is empty");
  if (facts.length > MAX_CHARS) throw new Error(`too long (${facts.length} > ${MAX_CHARS} chars)`);
  const actress = await db.actresses().findOne({ person_id: personId }, { projection: { name: 1, also_known_as: 1 } });
  if (!actress) throw new Error(`no actress with person_id ${personId}`);

  console.log(`${personId} (${(actress.also_known_as && actress.also_known_as.kr) || actress.name}): ${facts.length} chars${dryRun ? " (dry run, not saved)" : ""}`);
  if (!dryRun) {
    await db.verifiedFacts().updateOne({ person_id: personId }, { $set: { facts, updated_at: new Date() } }, { upsert: true });
    console.log("saved");
  }
  process.exit(0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
