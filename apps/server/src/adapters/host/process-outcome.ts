import type { CommandResult } from "@intrica/contracts";
export class ProcessOutcomeError extends Error {
  constructor(readonly outcome: CommandResult) {
    super(`Command ${outcome.termination}; task outcome is unverified`);
  }
}
