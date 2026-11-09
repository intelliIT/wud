import {
  getEolColor,
  getEolDescription,
  getEolLabel,
  isEolBadgeVisible,
  staysInEolCycle,
} from '@/services/eol';

describe('EOL service', () => {
  const eol = {
    status: 'eol' as const,
    source: 'purl' as const,
    product: 'postgresql',
    productLabel: 'PostgreSQL',
    cycle: '13',
    eolFrom: '2025-11-13',
  };

  it('shows a badge only for eol and eol-soon', () => {
    expect(isEolBadgeVisible(eol)).toBe(true);
    expect(isEolBadgeVisible({ ...eol, status: 'eol-soon' })).toBe(true);
    expect(isEolBadgeVisible({ ...eol, status: 'supported' })).toBe(false);
    expect(isEolBadgeVisible(undefined)).toBe(false);
  });

  it('maps status to colors and labels', () => {
    expect(getEolColor(eol)).toBe('error');
    expect(getEolColor({ ...eol, status: 'eol-soon' })).toBe('warning');
    expect(getEolColor({ ...eol, status: 'supported' })).toBe('success');
    expect(getEolColor(undefined)).toBe('grey');
    expect(getEolLabel(eol)).toBe('EOL');
    expect(getEolLabel({ ...eol, status: 'eol-soon' })).toBe('EOL soon');
  });

  it('describes endoflife.date status', () => {
    expect(getEolDescription(eol)).toContain('PostgreSQL 13 – EOL since');
    expect(getEolDescription({ ...eol, status: 'unknown', cycle: undefined })).toBe(
      'PostgreSQL – release cycle not found',
    );
    expect(getEolDescription(undefined)).toBe('');
  });

  it('describes policy status', () => {
    expect(
      getEolDescription({
        status: 'eol',
        source: 'policy',
        policy: 'latest-n-major:3',
        cycle: '15',
        newerLines: 3,
      }),
    ).toBe('Policy latest-n-major:3: 15 is no longer supported (3 newer major versions)');
    expect(
      getEolDescription({
        status: 'supported',
        source: 'policy',
        policy: 'latest-minor',
        cycle: '2.14',
        newerLines: 0,
      }),
    ).toBe('Policy latest-minor: 2.14 is supported (0 newer minor versions)');
  });

  it('detects candidates staying in the EOL cycle', () => {
    expect(staysInEolCycle('13.22', eol)).toBe(true);
    expect(staysInEolCycle('v13', eol)).toBe(true);
    expect(staysInEolCycle('130.0', eol)).toBe(false);
    expect(staysInEolCycle('17.2', eol)).toBe(false);
    expect(staysInEolCycle('13.22', { ...eol, status: 'supported' })).toBe(false);
  });
});
