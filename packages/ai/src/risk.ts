import { z } from 'zod';

export const riskInputSchema = z.object({
  days_waiting: z.number().int().min(0).max(7),
  prior_no_shows: z.number().int().min(0).max(20),
  contact_attempts: z.number().int().min(0).max(20),
  referral_rejected: z.boolean(),
  patient_acknowledged: z.boolean(),
  transport_barrier: z.boolean(),
}).strict();
export type RiskInput = z.infer<typeof riskInputSchema>;
const factorSchema=z.object({feature:z.string().max(80),value:z.number().finite(),log_odds_contribution:z.number().finite(),direction:z.enum(['increases','decreases'])});
export type OperationalRisk = {
  status: 'available'; probability: number; model: string; version:string; fallback:boolean;
  explanationMethod:string; factors:z.infer<typeof factorSchema>[];
  syntheticOnly: true; operationalOnly: true;
} | { status: 'unavailable' | 'insufficient_data'; reason: string; syntheticOnly: true; operationalOnly: true };

/** Missing inputs remain missing. Provider failure never changes clinical urgency. */
export async function predictOperationalRisk(input: unknown, options: { url: string; key: string; fetcher?: typeof fetch }): Promise<OperationalRisk> {
  const parsed = riskInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'insufficient_data', reason: 'All six operational features must be explicitly recorded at the prediction cutoff.', syntheticOnly: true, operationalOnly: true };
  if(options.key.length<32) return {status:'unavailable',reason:'The optional private research service has not been configured.',syntheticOnly:true,operationalOnly:true};
  try {
    const response = await (options.fetcher ?? fetch)(`${options.url.replace(/\/$/,'')}/predict`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Key': options.key },
      body: JSON.stringify(parsed.data), signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error('provider_unavailable');
    const result = z.object({
      probability: z.number().finite().min(0).max(1), model: z.string().min(1).max(100),version:z.string().min(1).max(200),
      fallback:z.boolean(),explanation_method:z.string().max(300),factors:z.array(factorSchema).max(6),
      synthetic_only:z.literal(true),operational_only:z.literal(true),clinical_validation:z.literal(false),
    }).parse(await response.json());
    return { status: 'available', probability: result.probability, model: result.model,version:result.version,fallback:result.fallback,explanationMethod:result.explanation_method,factors:result.factors,syntheticOnly: true, operationalOnly: true };
  } catch {
    return { status: 'unavailable', reason: 'The research model is unavailable. Human coordination and deadline escalation remain available.', syntheticOnly: true, operationalOnly: true };
  }
}
