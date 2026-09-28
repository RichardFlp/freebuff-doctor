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
export { buildHelperReport } from './report/helper.js'
export type { HelperReportInput } from './report/helper.js'
export {
  AI_MODEL,
  GROQ_API_BASE,
  keyFile,
  looksLikeApiKey,
  maskApiKey,
  readStoredKey,
  resolveApiKey,
  storeApiKey,
} from './ai/config.js'
export type { ApiKeySource } from './ai/config.js'
export { AiError, answerFromBody, chat, describeFailure } from './ai/client.js'
export type { ChatMessage, ChatOptions } from './ai/client.js'
export {
  buildFindings,
  buildSystemPrompt,
  buildUserMessage,
} from './ai/prompt.js'
export type { AssistantContext } from './ai/prompt.js'
export { AnswerRenderer, renderAnswer } from './ai/render.js'
export type { AnswerRendererOptions } from './ai/render.js'
export {
  inspectCheckout,
  printUpdateReport,
  runSelfUpdate,
} from './selfupdate/check.js'
export type {
  CheckoutStatus,
  SelfUpdateReport,
  UpdateStatus,
} from './selfupdate/check.js'
export { readUpdateState, writeUpdateState } from './selfupdate/state.js'
export type { UpdateState } from './selfupdate/state.js'
export { redact, redactLine } from './util/redact.js'
export {
  downloadsCandidates,
  reportFileName,
  resolveDownloadsDir,
} from './util/downloads.js'
export type { DownloadsResolution } from './util/downloads.js'
export { collectSnapshot, INTERESTING_VARIABLES } from './util/environment.js'
export type { EnvironmentSnapshot } from './util/environment.js'
export { resolvePlatformPaths } from './util/platform.js'
export { doctorVersion } from './util/version.js'
