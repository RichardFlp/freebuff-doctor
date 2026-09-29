/**
 * A deliberately crude token estimate: English prose and markdown average about
 * four characters per token. Exact counting would need the model's tokenizer,
 * and this is only used to keep a request inside a per-minute budget with room
 * to spare, so being approximate on the generous side is enough.
 */
export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4)
}
