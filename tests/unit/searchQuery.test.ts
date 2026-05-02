import { describe, it, expect } from 'vitest';
import { parseQuery, stringifyQuery } from '@/lib/search/query';

describe('parseQuery', () => {
  it('returns empty filters and text on empty input', () => {
    const r = parseQuery('');
    expect(r.filters).toEqual({});
    expect(r.text).toBe('');
  });

  it('parses tag operators, including comma-separated', () => {
    expect(parseQuery('tag:enzymes').filters.tags).toEqual(['enzymes']);
    expect(parseQuery('tag:enzymes,kinetics').filters.tags?.sort()).toEqual(['enzymes', 'kinetics']);
    expect(parseQuery('tag:a tag:b').filters.tags?.sort()).toEqual(['a', 'b']);
  });

  it('parses state operators and validates the value', () => {
    expect(parseQuery('state:new').filters.states).toEqual(['new']);
    expect(parseQuery('state:learning,review').filters.states?.sort()).toEqual(['learning', 'review']);
    // unknown state silently dropped
    expect(parseQuery('state:gibberish').filters.states).toBeUndefined();
  });

  it('parses tier operator and validates against the known set', () => {
    expect(parseQuery('tier:core').filters.tier).toBe('core');
    expect(parseQuery('tier:bogus').filters.tier).toBeUndefined();
  });

  it('parses lapses comparators', () => {
    expect(parseQuery('lapses>=3').filters.hasLapses).toBe(3);
    expect(parseQuery('lapses<=2').filters.lapsesAtMost).toBe(2);
    // = currently maps to hasLapses (best-effort)
    expect(parseQuery('lapses=5').filters.hasLapses).toBe(5);
  });

  it('parses added/edited durations with unit suffixes', () => {
    expect(parseQuery('added:7d').filters.addedWithinDays).toBe(7);
    expect(parseQuery('added:2w').filters.addedWithinDays).toBe(14);
    expect(parseQuery('added:1m').filters.addedWithinDays).toBe(30);
    expect(parseQuery('edited:3').filters.editedWithinDays).toBe(3);
  });

  it('parses is: pseudo-operators', () => {
    expect(parseQuery('is:suspended').filters.suspended).toBe(true);
    expect(parseQuery('is:buried').filters.buried).toBe(true);
    expect(parseQuery('is:due').filters.dueOnly).toBe(true);
    expect(parseQuery('is:new').filters.states).toEqual(['new']);
    // is:flagged expands to all flag types
    expect(new Set(parseQuery('is:flagged').filters.flags ?? [])).toEqual(
      new Set(['revisit', 'broken', 'exemplar', 'errata']),
    );
  });

  it('parses flag operator, single and comma-separated', () => {
    expect(parseQuery('flag:broken').filters.flags).toEqual(['broken']);
    expect(parseQuery('flag:revisit,errata').filters.flags?.sort()).toEqual(['errata', 'revisit']);
  });

  it('keeps unrecognized tokens as free text', () => {
    const r = parseQuery('foo bar tag:keep baz');
    expect(r.text).toBe('foo bar baz');
    expect(r.filters.tags).toEqual(['keep']);
  });

  it('respects double-quoted phrases as single tokens', () => {
    const r = parseQuery('"action potential" tag:bio');
    expect(r.text).toBe('action potential');
    expect(r.filters.tags).toEqual(['bio']);
  });
});

describe('stringifyQuery', () => {
  it('renders an empty filter set as empty string', () => {
    expect(stringifyQuery({}, '')).toBe('');
  });

  it('round-trips tag, state, tier, lapses, added, is:, flag', () => {
    const original = 'tier:core state:learning,review tag:enzymes lapses>=3 added:7d is:due flag:broken hello';
    const parsed = parseQuery(original);
    const back = stringifyQuery(parsed.filters, parsed.text);
    // Reparsing the stringified form should yield identical filters + text.
    const reparsed = parseQuery(back);
    expect(reparsed.filters).toEqual(parsed.filters);
    expect(reparsed.text).toBe(parsed.text);
  });

  it('drops free text when nothing remains', () => {
    expect(stringifyQuery({ suspended: true }, '')).toBe('is:suspended');
  });
});
