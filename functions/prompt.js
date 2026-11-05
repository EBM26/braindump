// The organizing prompt sent to Gemini along with the audio.
// (This file exports no onRequest handler, so it is not a public route.)
//
// Two parts:
//   USER_CONTEXT — personal context per user_id: who they are, their projects/clients
//                  and nicknames, time zone, and any personal rules. Edit your entry freely.
//   buildPrompt  — generic instructions + that user's context + today's date.

export const USER_CONTEXT = {
  eyal: {
    about: "Eyal, a freelance web developer and SEO specialist",
    timeZone: "Asia/Jerusalem",

    // Use these exact names in the "project" field, including when referred to by nickname.
    projects: `
- Landmark Construction — also "Landmark", "mylandmark"
- VeganKingz
- Soft & Sweet Sugaring — also "the sugaring site", "Soft and Sweet"
- seotools4free — also "my SEO tools site"
- Brain Dump App — also "this app"
[Eyal: add or edit clients and nicknames here]`,

    // Extra personal rules, appended to the generic ones. One per line, starting with "- ".
    rules: ``,
  },
};

/**
 * @param {string} userId  key into USER_CONTEXT
 * @param {{ date: string, weekday: string }} today  today's date in the user's time zone (YYYY-MM-DD)
 */
export function buildPrompt(userId, today) {
  const user = USER_CONTEXT[userId];
  if (!user) throw new Error(`No prompt context for user "${userId}"`);

  return `You are processing a voice brain dump from ${user.about}.

Today's date is ${today.weekday}, ${today.date} (time zone ${user.timeZone}).

Step 1: Transcribe the audio accurately, in the language the speaker used. Remove filler words ("um", "like") but do not change the meaning.

Step 2: Organize the content into:
- tasks: anything the speaker needs, wants, or should do. Phrases like "I need to", "I should", "remind me to", "don't forget" are tasks. Write each as a short, clear action starting with a verb.
- ideas: possibilities, product ideas, things the speaker is considering but hasn't committed to.
- open_questions: things the speaker is unsure about or needs to find out.
- notes: facts or information worth keeping that are none of the above.
- summary: 2 to 3 sentences covering the main points.

Projects and clients (use these exact names in the "project" field when the speaker refers to them, including by nickname):
${user.projects.trim()}

If an item doesn't clearly belong to a project, set project to null. Do not guess.

Due dates (tasks only):
- due_text: only fill it if the speaker stated a time ("by Friday", "tomorrow", "next week"). Keep the speaker's exact wording, in the language spoken. Otherwise null.
- due_date: the calendar date due_text refers to, as YYYY-MM-DD, resolved against today's date above. "tomorrow" is the day after today; "in two weeks" is 14 days from today; a weekday name like "Thursday" or "next Thursday" means the first Thursday after today.
- Set due_date to null when the timing doesn't point to one specific day ("soon", "sometime", "next week", "in a month or so", "one month-ish"). Never invent or guess a date. If due_text is null, due_date must be null.

Rules:
- Never invent tasks, deadlines, or details the speaker didn't say.
- If the speaker corrects themselves mid-thought ("actually, no..."), use the corrected version.
- If one sentence contains two separate actions, split them into two tasks.
- Keep items in the language the speaker used.
- If the audio is empty or unintelligible, return an empty transcript and empty arrays.${user.rules.trim() ? `\n${user.rules.trim()}` : ""}`;
}

/** Today's date and weekday in the given IANA time zone, e.g. { date: "2026-11-05", weekday: "Thursday" }. */
export function todayIn(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}
