// @ts-nocheck
import axios from 'axios';
import * as eol from './index';

jest.mock('axios');

const DAY_MS = 24 * 60 * 60 * 1000;

function container(overrides = {}) {
    return {
        name: 'test',
        labels: {},
        image: {
            name: 'library/postgres',
            registry: { name: 'hub', url: 'https://registry-1.docker.io/v2' },
            tag: { value: '16.4', semver: true },
        },
        ...overrides,
    };
}

const postgresProduct = {
    name: 'postgresql',
    label: 'PostgreSQL',
    links: { html: 'https://endoflife.date/postgresql' },
    releases: [
        {
            name: '17',
            isEol: false,
            eolFrom: '2029-11-08',
            latest: { name: '17.11' },
        },
        {
            name: '16',
            isEol: false,
            eolFrom: '2028-11-09',
            latest: { name: '16.15' },
        },
        {
            name: '13',
            isEol: true,
            eolFrom: '2025-11-13',
            latest: { name: '13.22' },
        },
    ],
};

function mockEndoflifeDate() {
    axios.get.mockImplementation(async (url) => {
        if (url.endsWith('/api/v1/identifiers/purl')) {
            return {
                data: {
                    result: [
                        {
                            identifier: 'pkg:docker/library/postgres',
                            product: { name: 'postgresql' },
                        },
                        {
                            identifier: 'pkg:npm/express',
                            product: { name: 'express' },
                        },
                    ],
                },
            };
        }
        if (url.endsWith('/api/v1/products/postgresql')) {
            return { data: { result: postgresProduct } };
        }
        const error = new Error('Not found');
        error.response = { status: 404 };
        throw error;
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    eol.resetForTests();
});

describe('parsePolicy', () => {
    test.each([
        ['latest-major', { level: 'major', olderLines: 0 }],
        ['latest-minor', { level: 'minor', olderLines: 0 }],
        ['latest-n-major:3', { level: 'major', olderLines: 2 }],
        ['latest-n-minor:2', { level: 'minor', olderLines: 1 }],
        [' LATEST-N-MINOR:4 ', { level: 'minor', olderLines: 3 }],
        ['latest-n-minor:1', { level: 'minor', olderLines: 0 }],
    ])('should parse %s', (value, expected) => {
        expect(eol.parsePolicy(value)).toEqual(expected);
    });

    test.each([
        'latest',
        'latest-2-major',
        'latest-n-minor',
        'latest-n-minor:0',
        'latest-n-patch:2',
        '',
        undefined,
    ])('should reject %s', (value) => {
        expect(eol.parsePolicy(value)).toBeUndefined();
    });
});

describe('getImagePurls', () => {
    test('should map official hub images to library namespace', () => {
        expect(
            eol.getImagePurls({ name: 'postgres', registry: { name: 'hub' } }),
        ).toEqual(['pkg:docker/library/postgres']);
    });

    test('should keep hub user images as is', () => {
        expect(
            eol.getImagePurls({
                name: 'bitnami/redis',
                registry: {
                    name: 'hub',
                    url: 'https://registry-1.docker.io/v2',
                },
            }),
        ).toEqual(['pkg:docker/bitnami/redis']);
    });

    test('should add repository_url for other registries', () => {
        expect(
            eol.getImagePurls({
                name: 'linuxserver/wireshark',
                registry: { name: 'lscr', url: 'https://lscr.io/v2' },
            }),
        ).toEqual(['pkg:docker/linuxserver/wireshark?repository_url=lscr.io']);
        expect(
            eol.getImagePurls({
                name: 'external-secrets/external-secrets',
                registry: { name: 'ghcr', url: 'https://ghcr.io/v2' },
            }),
        ).toEqual([
            'pkg:docker/external-secrets/external-secrets?repository_url=ghcr.io',
        ]);
    });

    test('should return nothing without image name', () => {
        expect(eol.getImagePurls(undefined)).toEqual([]);
    });
});

describe('matchCycle', () => {
    const releases = [
        { name: '3' },
        { name: '3.6' },
        { name: '16' },
        { name: 'trixie' },
    ];

    test.each([
        ['3.6.2', '3.6'],
        ['3.6', '3.6'],
        ['3.7.0', '3'],
        ['16.4', '16'],
        ['1.6.0', undefined],
        [undefined, undefined],
    ])('should match %s to %s', (version, expected) => {
        expect(eol.matchCycle(version, releases)?.name).toBe(expected);
    });
});

describe('getVersionForCycle', () => {
    test('should use the transformed semver tag', () => {
        expect(
            eol.getVersionForCycle(
                container({
                    transformTags: '^(\\d+\\.\\d+)-alpine$ => $1',
                    image: { tag: { value: '16.4-alpine', semver: true } },
                }),
            ),
        ).toBe('16.4');
        expect(
            eol.getVersionForCycle(
                container({
                    image: { tag: { value: 'v3.6.2', semver: true } },
                }),
            ),
        ).toBe('3.6.2');
    });

    test('should use the OCI image version for non semver tags', () => {
        expect(
            eol.getVersionForCycle(
                container({
                    image: {
                        tag: { value: 'latest', semver: false },
                        version: '17.2',
                    },
                }),
            ),
        ).toBe('17.2');
        expect(
            eol.getVersionForCycle(
                container({
                    image: { tag: { value: 'latest', semver: false } },
                }),
            ),
        ).toBeUndefined();
    });
});

describe('computeReleaseStatus', () => {
    const now = Date.parse('2026-11-09T00:00:00Z');

    test('should be eol when flagged or past eolFrom', () => {
        expect(eol.computeReleaseStatus({ isEol: true }, now, 90)).toBe('eol');
        expect(
            eol.computeReleaseStatus({ eolFrom: '2026-11-01' }, now, 90),
        ).toBe('eol');
    });

    test('should be eol-soon within warn days', () => {
        expect(
            eol.computeReleaseStatus(
                { eolFrom: new Date(now + 30 * DAY_MS).toISOString() },
                now,
                90,
            ),
        ).toBe('eol-soon');
        expect(
            eol.computeReleaseStatus(
                { eolFrom: new Date(now + 30 * DAY_MS).toISOString() },
                now,
                0,
            ),
        ).toBe('supported');
    });

    test('should be supported otherwise', () => {
        expect(
            eol.computeReleaseStatus({ eolFrom: '2028-11-09' }, now, 90),
        ).toBe('supported');
        expect(eol.computeReleaseStatus({ eolFrom: null }, now, 90)).toBe(
            'supported',
        );
    });
});

describe('policy labels', () => {
    function withPolicy(policy, tag, newerLines) {
        return container({
            labels: { 'wud.eol.policy': policy },
            image: { name: 'x/y', tag: { value: tag, semver: true } },
            result: newerLines ? { tag, newerLines } : undefined,
        });
    }

    test('latest-n-major:3: 15.1 is EOL when 18, 17 and 16 exist', () => {
        expect(
            eol.getContainerEol(
                withPolicy('latest-n-major:3', '15.1', { major: 3, minor: 3 }),
            ),
        ).toEqual({
            status: 'eol',
            source: 'policy',
            policy: 'latest-n-major:3',
            cycle: '15',
            newerLines: 3,
        });
    });

    test('latest-n-major:3: 16.1 is supported when 18 and 17 exist', () => {
        expect(
            eol.getContainerEol(
                withPolicy('latest-n-major:3', '16.1', { major: 2, minor: 2 }),
            ).status,
        ).toBe('supported');
    });

    test('latest-minor: 2.13.1 is EOL when 2.14 exists', () => {
        const result = eol.getContainerEol(
            withPolicy('latest-minor', '2.13.1', { major: 0, minor: 1 }),
        );
        expect(result.status).toBe('eol');
        expect(result.cycle).toBe('2.13');
    });

    test('latest-minor: supported when only patches are newer', () => {
        expect(
            eol.getContainerEol(
                withPolicy('latest-minor', '2.13.1', { major: 0, minor: 0 }),
            ).status,
        ).toBe('supported');
    });

    test('latest-n-minor:2: 2.12 is EOL when 2.14 and 2.13 exist', () => {
        expect(
            eol.getContainerEol(
                withPolicy('latest-n-minor:2', '2.12.0', {
                    major: 0,
                    minor: 2,
                }),
            ).status,
        ).toBe('eol');
        expect(
            eol.getContainerEol(
                withPolicy('latest-n-minor:2', '2.13.0', {
                    major: 0,
                    minor: 1,
                }),
            ).status,
        ).toBe('supported');
    });

    test('should be unknown without newer lines data', () => {
        expect(
            eol.getContainerEol(withPolicy('latest-minor', '2.13.1')),
        ).toBeUndefined();
    });

    test('should ignore invalid policies', () => {
        expect(
            eol.getContainerEol(
                withPolicy('latest-n-minor:x', '2.13.1', {
                    major: 0,
                    minor: 1,
                }),
            ),
        ).toBeUndefined();
    });

    test('should work while endoflife.date lookup is disabled', () => {
        expect(axios.get).not.toHaveBeenCalled();
        expect(
            eol.getContainerEol(
                withPolicy('latest-major', '1.0.0', { major: 1, minor: 1 }),
            ).status,
        ).toBe('eol');
    });
});

describe('endoflife.date lookup', () => {
    test('should not return anything nor call the api when disabled', () => {
        expect(eol.getContainerEol(container())).toBeUndefined();
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('should resolve product by purl and cycle by tag', async () => {
        mockEndoflifeDate();
        eol.resetForTests({ enabled: true });
        await eol.refresh();

        // Product is loaded lazily on first lookup
        expect(eol.getContainerEol(container())).toBeUndefined();
        await eol.waitForPendingLoads();

        expect(eol.getContainerEol(container())).toEqual({
            status: 'supported',
            source: 'purl',
            product: 'postgresql',
            productLabel: 'PostgreSQL',
            link: 'https://endoflife.date/postgresql',
            cycle: '16',
            eolFrom: '2028-11-09',
            latestInCycle: '16.15',
        });
        expect(
            eol.getContainerEol(
                container({
                    image: {
                        ...container().image,
                        tag: { value: '13.4', semver: true },
                    },
                }),
            ).status,
        ).toBe('eol');
    });

    test('should be unknown when no cycle matches', async () => {
        mockEndoflifeDate();
        eol.resetForTests({ enabled: true });
        await eol.refresh();
        const c = container({
            image: {
                ...container().image,
                tag: { value: '9.6', semver: true },
            },
        });
        eol.getContainerEol(c);
        await eol.waitForPendingLoads();
        expect(eol.getContainerEol(c)).toMatchObject({
            status: 'unknown',
            product: 'postgresql',
        });
    });

    test('should use product and cycle labels', async () => {
        mockEndoflifeDate();
        eol.resetForTests({ enabled: true });
        const c = container({
            labels: { 'wud.eol.product': 'PostgreSQL', 'wud.eol.cycle': '13' },
            image: {
                name: 'myorg/db',
                tag: { value: 'latest', semver: false },
            },
        });
        eol.getContainerEol(c);
        await eol.waitForPendingLoads();
        expect(eol.getContainerEol(c)).toMatchObject({
            status: 'eol',
            source: 'label',
            cycle: '13',
        });
    });

    test('should skip containers labelled with product none', async () => {
        mockEndoflifeDate();
        eol.resetForTests({ enabled: true });
        await eol.refresh();
        expect(
            eol.getContainerEol(
                container({ labels: { 'wud.eol.product': 'none' } }),
            ),
        ).toBeUndefined();
        await eol.waitForPendingLoads();
        expect(axios.get).not.toHaveBeenCalledWith(
            expect.stringContaining('/products/'),
            expect.anything(),
        );
    });

    test('should not retry unknown products until next refresh', async () => {
        mockEndoflifeDate();
        eol.resetForTests({ enabled: true });
        const c = container({ labels: { 'wud.eol.product': 'nope' } });
        eol.getContainerEol(c);
        await eol.waitForPendingLoads();
        eol.getContainerEol(c);
        await eol.waitForPendingLoads();
        expect(
            axios.get.mock.calls.filter(([url]) => url.endsWith('/nope')),
        ).toHaveLength(1);
    });

    test('should keep previous data when endoflife.date is unreachable', async () => {
        mockEndoflifeDate();
        eol.resetForTests({ enabled: true });
        await eol.refresh();
        eol.getContainerEol(container());
        await eol.waitForPendingLoads();

        axios.get.mockRejectedValue(new Error('ECONNREFUSED'));
        await eol.refresh();

        expect(eol.getContainerEol(container()).status).toBe('supported');
    });
});
