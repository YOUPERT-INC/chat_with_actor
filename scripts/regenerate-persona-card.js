/**
 * Makes a character card again ON PURPOSE (cards are otherwise frozen once created).
 *
 *   node scripts/regenerate-persona-card.js <person_id> [<person_id> ...]
 *   node scripts/regenerate-persona-card.js --all          every chattable actress
 *   add --dry-run to print the new card without saving it
 *
 * Conversations in progress will meet the new personality on their next message, so do this
 * deliberately (e.g. after improving the card prompt), not routinely. Needs MONGODB_URI and
 * DEEPSEEK_API_KEY like the server. The running server keeps the old card in memory for up to
 * an hour: `pm2 restart chat-ai` afterwards to apply it at once.
 */
const db = require("../src/db");
const { koreanOverview, isChattable } = require("../src/persona");
const { generateCard, sourceHash, defaultStore } = require("../src/personaCard");

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const ids = args.filter((a) => !a.startsWith("--"));
  const all = args.includes("--all");
  if (!all && ids.length === 0) {
    console.log("usage: regenerate-persona-card.js <person_id ...> | --all [--dry-run]");
    process.exit(1);
  }

  await db.connect();
  const filter = all
    ? { is_active: { $ne: 0 }, description: { $elemMatch: { language: "ko" } } }
    : { person_id: { $in: ids } };
  const docs = await db
    .actresses()
    .find(filter, { projection: { person_id: 1, name: 1, description: 1 } })
    .toArray();

  let done = 0;
  let skipped = 0;
  for (const doc of docs) {
    const ko = koreanOverview(doc.description);
    if (!isChattable(ko)) {
      skipped++;
      continue; // shorter than MIN_DESCRIPTION_CHARS: not chat-worthy
    }
    const card = await generateCard(ko);
    if (!card) {
      console.log(`x ${doc.person_id} ${doc.name}: card rejected twice, kept the old one`);
      continue;
    }
    if (dryRun) {
      console.log(`--- ${doc.person_id} ${doc.name}\n${card}\n`);
    } else {
      await defaultStore.save({ person_id: doc.person_id, card, source_hash: sourceHash(ko), created_at: new Date() });
      console.log(`ok ${doc.person_id} ${doc.name}`);
    }
    done++;
  }
  console.log(`\n${done} card(s) ${dryRun ? "generated (dry run, nothing saved)" : "saved"}, ${skipped} skipped (description too short), ${docs.length} matched`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
