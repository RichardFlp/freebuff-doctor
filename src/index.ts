/**
 * Programmatic API for freebuff-doctor.
 *
 * The CLI (`fbdoc`) is the primary interface; these exports exist so the checks,
 * FAQ search and report builder can be reused in scripts and CI pipelines.
 */

export { CHECKS, listChecks, runChecks, selectChecks } from './checks/index.js'
export type { RunChecksOptions, ProgressEvent } from './checks/index.js'
export { createContext, found, summarize } from './checks/types.js'
export type {
  CheckContext,
  CheckResult,
  CheckStatus,
  CheckSummary,
  DiagnosticCheck,
} from './checks/types.js'
export { findSection, loadFaq, parseFaq, slugifyHeading } from './faq/loader.js'
export type { Faq, FaqSection } from './faq/loader.js'
export {
  createIndex,
  decideMatches,
  normalize,
  searchFaq,
  searchIndex,
} from './faq/search.js'
export type { FaqIndex, FaqMatch, MatchDecision } from './faq/search.js'
export { buildSupportReport, collectLogExcerpts } from './report/support.js'
export type { SupportReportInput, LogExcerpt } from './report/support.js'
export { redact, redactLine } from './util/redact.js'
export { resolvePlatformPaths } from './util/platform.js'
export { doctorVersion } from './util/version.js'
