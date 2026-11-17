export type Severity = "error" | "warning"

/** something wrong or worth saying about the workspace, and where it is */
export interface Issue {
  severity: Severity
  where: string
  message: string
}
