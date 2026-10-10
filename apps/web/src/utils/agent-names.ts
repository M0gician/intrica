import { nextAgentName as generateName } from "@intrica/contracts";
import i18n from "../i18n";

export function nextAgentName(existing: Iterable<string>, random = Math.random): string {
  return generateName(existing, i18n.language, random);
}
