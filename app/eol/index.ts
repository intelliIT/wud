/**
 * End-of-life (EOL) status of container images.
 *
 * Two sources, in this order:
 * - Labels: `wud.eol.product` (+ optional `wud.eol.cycle`) maps to an
 *   endoflife.date product, `wud.eol.policy` (e.g. `latest-2-major`) derives
 *   the status from the newer release lines WUD found in the registry.
 * - endoflife.date purl identifiers (e.g. `pkg:docker/library/postgres`).
 *
 * endoflife.date data is kept in an in-memory cache, refreshed on a cron
 * schedule; products are fetched lazily the first time a container needs
 * them. Lookups never block nor throw: missing data means "no EOL status".
 */
import axios from 'axios';
import cron, { ScheduledTask } from 'node-cron';
import logger from '../log';
import { getEolConfiguration } from '../configuration';
import { transform as transformTag } from '../tag';
import type { Container, ContainerEol } from '../model/container';

const log = logger.child({ component: 'eol' });

const PRODUCT_LABEL_KEYS = [
    'wud.eol.product',
    'getwud.app/eol.product',
    'wud/eol.product',
    'wud.getwud.io/eol.product',
];
const CYCLE_LABEL_KEYS = [
    'wud.eol.cycle',
    'getwud.app/eol.cycle',
    'wud/eol.cycle',
    'wud.getwud.io/eol.cycle',
];
const POLICY_LABEL_KEYS = [
    'wud.eol.policy',
    'getwud.app/eol.policy',
    'wud/eol.policy',
    'wud.getwud.io/eol.policy',
];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EolRelease {
    name: string;
    isEol?: boolean;
    eolFrom?: string | null;
    latest?: { name?: string } | null;
}

export interface EolProduct {
    name: string;
    label?: string;
    link?: string;
    releases: EolRelease[];
}

export interface EolPolicy {
    level: 'major' | 'minor';
    olderLines: number;
}

let configuration = {
    enabled: false,
    cron: '0 4 * * *',
    warndays: 90,
    url: 'https://endoflife.date',
};
const purlToProduct = new Map<string, string>();
const products = new Map<string, EolProduct>();
const pendingProducts = new Map<string, Promise<void>>();
const unknownProducts = new Set<string>();
const invalidPolicyWarnings = new Set<string>();
let refreshTask: ScheduledTask | undefined;

function getFirstLabel(
    labels: Record<string, string> | undefined,
    keys: string[],
): string | undefined {
    if (!labels) return undefined;
    for (const key of keys) {
        const value = labels[key];
        if (value !== undefined && value !== null && `${value}`.trim()) {
            return `${value}`.trim();
        }
    }
    return undefined;
}

/**
 * Parse a policy label value.
 * Accepts `latest-major`, `latest-minor` (only the newest line is supported)
 * and `latest-n-major:<n>`, `latest-n-minor:<n>` (the newest n lines are
 * supported, e.g. `latest-n-major:3` supports 18, 17 and 16).
 */
export function parsePolicy(value?: string): EolPolicy | undefined {
    const match = /^latest-(?:n-(major|minor):(\d+)|(major|minor))$/i.exec(
        `${value ?? ''}`.trim(),
    );
    if (!match) {
        return undefined;
    }
    const supportedLines = match[2] ? Number.parseInt(match[2], 10) : 1;
    if (supportedLines < 1) {
        return undefined;
    }
    return {
        level: (match[1] || match[3]).toLowerCase() as EolPolicy['level'],
        olderLines: supportedLines - 1,
    };
}

/**
 * Build the endoflife.date purl identifiers for an image.
 * Docker Hub images map to `pkg:docker/<name>`, other registries also
 * carry a `repository_url` qualifier (e.g. lscr.io).
 */
export function getImagePurls(image?: Container['image']): string[] {
    if (!image?.name) {
        return [];
    }
    const name = image.name.toLowerCase();
    let host: string | undefined;
    try {
        host = image.registry?.url
            ? new URL(image.registry.url).host.toLowerCase()
            : undefined;
    } catch {
        host = undefined;
    }
    const isHub =
        !host ||
        host.endsWith('docker.io') ||
        `${image.registry?.name ?? ''}`.toLowerCase().startsWith('hub');
    if (isHub) {
        const hubName = name.includes('/') ? name : `library/${name}`;
        return [`pkg:docker/${hubName}`];
    }
    return [`pkg:docker/${name}?repository_url=${host}`];
}

/**
 * Extract the numeric version (e.g. 3.6.2) used to find the release cycle.
 * Uses the transformed tag for semver tags, the OCI image version otherwise.
 */
export function getVersionForCycle(container: Container): string | undefined {
    const tag = container.image?.tag;
    let rawVersion: string | undefined;
    if (tag?.semver) {
        rawVersion = transformTag(
            container.transformTags,
            tag.value,
            container,
        );
    } else {
        rawVersion = container.image?.version;
    }
    const match = /^v?(\d+(?:\.\d+)*)/i.exec(`${rawVersion ?? ''}`.trim());
    return match ? match[1] : undefined;
}

/**
 * Find the release cycle of a version: the longest numeric release name
 * that matches the version on a dot boundary (3.6.2 -> 3.6, 16.4 -> 16).
 */
export function matchCycle(
    version: string | undefined,
    releases: EolRelease[],
): EolRelease | undefined {
    if (!version) {
        return undefined;
    }
    let best: EolRelease | undefined;
    for (const release of releases || []) {
        const name = `${release.name ?? ''}`;
        if (!/^\d+(\.\d+)*$/.test(name)) {
            continue;
        }
        if (version === name || version.startsWith(`${name}.`)) {
            if (!best || name.length > best.name.length) {
                best = release;
            }
        }
    }
    return best;
}

/**
 * Compute the EOL status of an endoflife.date release.
 */
export function computeReleaseStatus(
    release: EolRelease,
    now: number,
    warnDays: number,
): ContainerEol['status'] {
    const eolFrom = release.eolFrom ? Date.parse(release.eolFrom) : NaN;
    if (release.isEol || (!Number.isNaN(eolFrom) && eolFrom <= now)) {
        return 'eol';
    }
    if (!Number.isNaN(eolFrom) && eolFrom - now <= warnDays * DAY_MS) {
        return 'eol-soon';
    }
    return 'supported';
}

/**
 * Compute the EOL status from a policy label and the newer lines found.
 */
export function computePolicyEol(
    container: Container,
    policyValue: string,
): ContainerEol | undefined {
    const policy = parsePolicy(policyValue);
    if (!policy) {
        if (invalidPolicyWarnings.has(policyValue)) {
            return undefined;
        }
        invalidPolicyWarnings.add(policyValue);
        log.warn(
            `Invalid EOL policy "${policyValue}" for container ${container.name} (expected latest-major, latest-minor, latest-n-major:<n> or latest-n-minor:<n>)`,
        );
        return undefined;
    }
    const newerLines = container.result?.newerLines;
    if (!newerLines) {
        return undefined;
    }
    const version = getVersionForCycle(container);
    const versionParts = version ? version.split('.') : [];
    const newerCount = newerLines[policy.level];
    return {
        status: newerCount > policy.olderLines ? 'eol' : 'supported',
        source: 'policy',
        policy: policyValue,
        cycle:
            policy.level === 'major'
                ? versionParts[0]
                : versionParts.slice(0, 2).join('.') || undefined,
        newerLines: newerCount,
    };
}

async function fetchJson(path: string) {
    const response = await axios.get(`${configuration.url}${path}`, {
        timeout: 15000,
        headers: { Accept: 'application/json' },
    });
    return response.data?.result;
}

async function loadPurls() {
    const result = await fetchJson('/api/v1/identifiers/purl');
    const identifiers = Array.isArray(result) ? result : [];
    purlToProduct.clear();
    for (const identifier of identifiers) {
        if (
            typeof identifier?.identifier === 'string' &&
            identifier.identifier.startsWith('pkg:docker/') &&
            identifier.product?.name
        ) {
            purlToProduct.set(
                identifier.identifier.toLowerCase(),
                identifier.product.name,
            );
        }
    }
    log.debug(`Loaded ${purlToProduct.size} docker identifiers`);
}

async function loadProduct(productName: string) {
    try {
        const result = await fetchJson(
            `/api/v1/products/${encodeURIComponent(productName)}`,
        );
        if (!result || !Array.isArray(result.releases)) {
            throw new Error('unexpected response');
        }
        products.set(productName, {
            name: result.name ?? productName,
            label: result.label,
            link: result.links?.html,
            releases: result.releases,
        });
        unknownProducts.delete(productName);
    } catch (e: any) {
        if (e?.response?.status === 404) {
            unknownProducts.add(productName);
            log.warn(`Unknown endoflife.date product "${productName}"`);
        } else {
            log.warn(
                `Unable to load endoflife.date product "${productName}" (${e?.message})`,
            );
        }
    } finally {
        pendingProducts.delete(productName);
    }
}

/**
 * Request a product in the background (deduplicated).
 */
function requestProduct(productName: string) {
    if (
        !configuration.enabled ||
        products.has(productName) ||
        unknownProducts.has(productName) ||
        pendingProducts.has(productName)
    ) {
        return;
    }
    pendingProducts.set(productName, loadProduct(productName));
}

/**
 * Compute the EOL status of a container from endoflife.date data.
 */
function computeProductEol(
    container: Container,
    productName: string,
    source: ContainerEol['source'],
    cycleOverride?: string,
): ContainerEol | undefined {
    const product = products.get(productName);
    if (!product) {
        requestProduct(productName);
        return undefined;
    }
    const release = cycleOverride
        ? product.releases.find((r) => `${r.name}` === cycleOverride)
        : matchCycle(getVersionForCycle(container), product.releases);
    const eol: ContainerEol = {
        status: 'unknown',
        source,
        product: product.name,
        productLabel: product.label,
        link: product.link,
    };
    if (release) {
        eol.cycle = `${release.name}`;
        eol.status = computeReleaseStatus(
            release,
            Date.now(),
            configuration.warndays,
        );
        eol.eolFrom = release.eolFrom ?? undefined;
        eol.latestInCycle = release.latest?.name ?? undefined;
    }
    return eol;
}

/**
 * Get the EOL status of a container (undefined when unknown).
 */
export function getContainerEol(
    container: Container,
): ContainerEol | undefined {
    const labels = container.labels;
    const productLabel = getFirstLabel(labels, PRODUCT_LABEL_KEYS);
    if (productLabel && productLabel.toLowerCase() === 'none') {
        return undefined;
    }
    if (productLabel) {
        if (!configuration.enabled) {
            return undefined;
        }
        return computeProductEol(
            container,
            productLabel.toLowerCase(),
            'label',
            getFirstLabel(labels, CYCLE_LABEL_KEYS),
        );
    }
    const policyLabel = getFirstLabel(labels, POLICY_LABEL_KEYS);
    if (policyLabel) {
        return computePolicyEol(container, policyLabel);
    }
    if (!configuration.enabled) {
        return undefined;
    }
    for (const purl of getImagePurls(container.image)) {
        const productName = purlToProduct.get(purl);
        if (productName) {
            return computeProductEol(container, productName, 'purl');
        }
    }
    return undefined;
}

/**
 * Reload the purl identifiers and all products already in use.
 */
export async function refresh() {
    if (!configuration.enabled) {
        return;
    }
    try {
        await loadPurls();
    } catch (e: any) {
        log.warn(
            `Unable to load endoflife.date identifiers; keeping previous data (${e?.message})`,
        );
    }
    unknownProducts.clear();
    await Promise.all([...products.keys()].map((name) => loadProduct(name)));
}

/**
 * Init the EOL module (load configuration, data and schedule refresh).
 */
export function init() {
    configuration = getEolConfiguration();
    if (!configuration.enabled) {
        log.debug('EOL lookup on endoflife.date disabled');
        return;
    }
    log.info(
        `EOL lookup enabled (source=${configuration.url}, cron=${configuration.cron}, warndays=${configuration.warndays})`,
    );
    // Do not block startup on endoflife.date (errors are logged in refresh)
    refresh();
    refreshTask?.stop();
    refreshTask = cron.schedule(configuration.cron, () => {
        refresh();
    });
}

/**
 * Test helper: reset the module state.
 */
export function resetForTests(
    newConfiguration?: Partial<typeof configuration>,
) {
    configuration = {
        enabled: false,
        cron: '0 4 * * *',
        warndays: 90,
        url: 'https://endoflife.date',
        ...newConfiguration,
    };
    purlToProduct.clear();
    products.clear();
    pendingProducts.clear();
    unknownProducts.clear();
    invalidPolicyWarnings.clear();
    refreshTask?.stop();
    refreshTask = undefined;
}

/**
 * Test helper: wait for pending product loads.
 */
export async function waitForPendingLoads() {
    await Promise.all([...pendingProducts.values()]);
}
