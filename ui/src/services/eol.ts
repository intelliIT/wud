export interface ContainerEol {
  status: "eol" | "eol-soon" | "supported" | "unknown";
  source: "label" | "policy" | "purl";
  product?: string;
  productLabel?: string;
  cycle?: string;
  eolFrom?: string;
  latestInCycle?: string;
  link?: string;
  policy?: string;
  newerLines?: number;
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

/**
 * Whether the EOL status deserves a badge (eol or eol-soon).
 */
export function isEolBadgeVisible(eol?: ContainerEol) {
  return eol?.status === "eol" || eol?.status === "eol-soon";
}

export function getEolColor(eol?: ContainerEol) {
  switch (eol?.status) {
    case "eol":
      return "error";
    case "eol-soon":
      return "warning";
    case "supported":
      return "success";
    default:
      return "grey";
  }
}

export function getEolLabel(eol?: ContainerEol) {
  switch (eol?.status) {
    case "eol":
      return "EOL";
    case "eol-soon":
      return "EOL soon";
    case "supported":
      return "Supported";
    default:
      return "Unknown";
  }
}

/**
 * Human readable explanation of the EOL status.
 */
export function getEolDescription(eol?: ContainerEol) {
  if (!eol) return "";
  if (eol.source === "policy") {
    const level = eol.policy?.includes("major") ? "major" : "minor";
    const newer = `${eol.newerLines ?? 0} newer ${level} version${eol.newerLines === 1 ? "" : "s"}`;
    return eol.status === "eol"
      ? `Policy ${eol.policy}: ${eol.cycle ?? "this version"} is no longer supported (${newer})`
      : `Policy ${eol.policy}: ${eol.cycle ?? "this version"} is supported (${newer})`;
  }
  const product = `${eol.productLabel || eol.product || ""}${eol.cycle ? ` ${eol.cycle}` : ""}`;
  switch (eol.status) {
    case "eol":
      return eol.eolFrom ? `${product} – EOL since ${formatDate(eol.eolFrom)}` : `${product} – EOL`;
    case "eol-soon":
      return `${product} – EOL on ${formatDate(eol.eolFrom)}`;
    case "supported":
      return eol.eolFrom ? `${product} – supported until ${formatDate(eol.eolFrom)}` : `${product} – supported`;
    default:
      return `${product} – release cycle not found`;
  }
}

/**
 * Whether an update candidate stays in the current (EOL) release cycle.
 */
export function staysInEolCycle(candidateTag: string, eol?: ContainerEol) {
  if (!isEolBadgeVisible(eol) || !eol?.cycle) return false;
  const version = /^v?(\d+(?:\.\d+)*)/i.exec(candidateTag)?.[1];
  return Boolean(version && (version === eol.cycle || version.startsWith(`${eol.cycle}.`)));
}
