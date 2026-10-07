export type Call = (path: string, method?: string, body?: unknown) => Promise<any>;
export function until<T>(check: () => Promise<T>, timeout?: number): Promise<NonNullable<T>>;
export function prepareJourney(
  call: Call,
  options?: { pauseSecondHire?: boolean },
): Promise<{
  board: any;
  manager: any;
  start(): Promise<any>;
  close(): Promise<void>;
  releaseRecruitment(): void;
  holding: Promise<void>;
  holdMember(id: string): Promise<any>;
}>;
export function verifyJourney(
  call: Call,
  journey: Awaited<ReturnType<typeof prepareJourney>>,
): Promise<any[]>;
export function seedPendingApproval(
  call: Call,
  journey: Awaited<ReturnType<typeof prepareJourney>>,
): Promise<any>;
export function verifyPendingApproval(
  call: Call,
  journey: Awaited<ReturnType<typeof prepareJourney>>,
  saved: any,
): Promise<void>;
