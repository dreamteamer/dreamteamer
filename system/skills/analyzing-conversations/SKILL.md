---
name: analyzing-conversations
description: extract structured records (tasks, insights, decisions, contacts, …) from a transcript or thread into their target collections, with refs back to the source
---

# analyzing conversations

**core principle:** an extraction that ends in a summary paragraph is a failed extraction. every
item worth keeping becomes a record in a real collection, with a reference back to its source.

## when to use

conversational text needs to become structure: a meeting transcript just landed, the operator
pasted a thread or notes, a workflow's extract step is running, someone asks "what did we agree
to / who owes what from this".

**not for:** getting the transcript into the meeting record in the first place
(`transcribe-recordings`), writing a prose summary (that's the summarize step's prompt, not this
skill), or deriving events from git history (`detecting-data-changes-via-git`).

## the pass

1. **read the whole source first.** a `.meeting.md`, a pasted thread, whatever it is. never
   extract from a partial read — the assignment usually lands three paragraphs after the ask.
2. **classify each candidate by what it IS, not where it appeared**, and pick the target from
   `.dreamteamer/system/collections/` — the real list, not from memory.
3. **write it** with `working-with-structured-data-files` conventions: the CLI is the fast path
   (`npm run --silent dt -- <collection> add …`); drop to direct file edits only for structured
   bodies or batch consistency.
4. **backlink every record to its source** — `item: <collection>/<id>` (e.g.
   `item: meetings/2026/07/standup`). without it the extraction is a copy that drifts.

## picking the target collection

| the item is | goes to |
|---|---|
| a concrete action someone owes | `tasks` (+ `item:` backlink) |
| a person mentioned who isn't a record yet | `contacts` |
| an org mentioned that isn't a record yet | `companies` |
| a build/architecture decision in this workspace | a `DECISION-LOG.md` row, per `CLAUDE.md` |
| "an insight" / "a takeaway" | usually the summary body or a task note — **not** a new collection |

**don't invent a plausible-sounding collection** (`insights`, `decisions`, `risks`) because the
source text used that word. if a genuine recurring gap exists, use `writing-collections`
deliberately; otherwise fold the item into the nearest real collection.

## assignment

only assign a task to an actual workspace user (`users/<id>`, a record in `data/users/`) — see
`working-with-tasks`. an action item owned by someone outside the workspace (a client, a contact)
stays **unassigned** with the owner named in the body, and per decision #12 is better folded into
the responsible user's task as a follow-up than left standing alone.

## after the pass

run `npm run check` — a batch pull from a long transcript is exactly the edit that produces a
stray enum value or an unresolved reference. commit per collection touched (or per logical
group), never one giant commit mixing tasks, contacts and companies.

## common mistakes

| mistake | reality |
|---|---|
| reporting findings as a summary and stopping | nobody can query or assign a paragraph. write the records. |
| extracting while still reading | the owner and the deadline usually arrive later in the text. |
| creating an `insights` / `decisions` collection for one extraction | a collection is for things that recur. fold it in. |
| a record with no `item:` backlink | the extraction becomes untraceable and drifts from the source. |
| assigning to the person who *said* it | assign to the workspace user who owes it — or leave it unassigned. |
| inventing `users/<name>` for an outsider | users are workspace members. name them in the body. |
| turning every hedged remark into a task | extract what someone actually owes, not everything mentioned. |
| one commit for the whole extraction | one commit per collection / logical group. |
