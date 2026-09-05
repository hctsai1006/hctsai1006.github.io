/**
 * The portfolio commands, as one registry.
 *
 * Split from `native/` because they are a different KIND of native-semantic:
 * these read `src/data/*.json` — the site's real content — and every one of
 * them declares `portfolio.read`. The system commands declare no capability at
 * all except Clear-Host's `terminal.control`.
 *
 * `whoami` is a factory because it reports the simulated machine's user name,
 * which is injected; the other seven have no ambient dependency at all.
 */

import type { CommandModule } from '../invocation.ts';
import { SIMULATED_MACHINE } from '../native/services.ts';
import type { MachineIdentity } from '../native/services.ts';
import {
  createWhoami,
  getAdvisory,
  getAward,
  getContribution,
  getProject,
  getPublication,
  getSource,
  getTimeline,
} from './commands.ts';

export {
  advisoryRows,
  awardRows,
  contributionRows,
  contributionSummary,
  createWhoami,
  getAdvisory,
  getAward,
  getContribution,
  getProject,
  getPublication,
  getSource,
  getTimeline,
  identityRows,
  profileObject,
  projectRows,
  publicationRows,
  publicationSummary,
  sourceRows,
  timelineRows,
} from './commands.ts';
export * from './data.ts';
export { SITE, SOURCES, SOURCE_BANNER, SOURCE_URLS } from './sources.ts';

export function createPortfolioCommands(
  machine: MachineIdentity = SIMULATED_MACHINE,
): readonly CommandModule[] {
  return [
    createWhoami({ machine }),
    getContribution,
    getPublication,
    getAward,
    getAdvisory,
    getProject,
    getTimeline,
    getSource,
  ];
}

/** The default registry, bound to the simulated machine. */
export const PORTFOLIO_COMMANDS: readonly CommandModule[] = createPortfolioCommands();
