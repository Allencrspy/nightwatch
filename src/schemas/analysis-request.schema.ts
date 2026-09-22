import { z } from 'zod';

export const IntradayAnalysisRequestSchema = z.object({
  capital: z.number().positive().default(500000),
  riskPercent: z.number().positive().max(5).default(0.5),
  maxTrades: z.number().int().min(1).max(10).default(3),
  forceRefresh: z.boolean().optional().default(false),
});

export type IntradayAnalysisRequest = z.infer<typeof IntradayAnalysisRequestSchema>;
