import { z } from 'zod';

export const IntradayAnalysisRequestSchema = z.object({
  capital: z.number().positive().default(500000),
  riskPercent: z.number().positive().max(5).default(0.5),
  maxTrades: z.number().int().min(1).max(10).default(3),
  forceRefresh: z.boolean().optional().default(false),
  /** 'fno' scans the F&O list; 'all' adds the most liquid non-F&O names. */
  universe: z.enum(['fno', 'all']).optional().default('fno'),
});

export type IntradayAnalysisRequest = z.infer<typeof IntradayAnalysisRequestSchema>;
