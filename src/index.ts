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
  ANSWER_TEMPERATURE,
  GROQ_API_BASE,
  keyFile,
  looksLikeApiKey,
  maskApiKey,
  readStoredKey,
  resolveApiKey,
  storeApiKey,
} from './ai/config.js'
export type { ApiKeySource } from './ai/config.js'
export {
  AiError,
  answerFromBody,
  chat,
  describeFailure,
  fitMessages,
  MAX_REQUEST_TOKENS,
} from './ai/client.js'
export type { ChatMessage, ChatOptions } from './ai/client.js'
export {
  buildFindings,
  buildKnowledgeMessage,
  buildSystemPrompt,
  buildUserMessage,
} from './ai/prompt.js'
export type { AssistantContext } from './ai/prompt.js'
export {
  buildKnowledge,
  buildTurnKnowledge,
  checkCatalogue,
  faqIndex,
  relevantSections,
} from './ai/knowledge.js'
export { commandClaims, unsupportedClaims } from './ai/grounding.js'
export { estimateTokens } from './util/tokens.js'
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
