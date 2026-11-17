import type { Issue } from "../types/Issue.ts"

/** An error a user can cause: one line that says what to do, and the issues behind it. */
export class DtError extends Error {
  issues: Issue[]
  constructor(message: string, issues: Issue[] = []) {
    super(message)
    this.issues = issues
  }
}
