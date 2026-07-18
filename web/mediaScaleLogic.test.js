import { describe, expect, it } from 'vitest';
import {
  MEDIA_PAGE_SIZE,
  filterMediaSources,
  mediaFocusTarget,
  mediaPage,
  mediaSearchTerms,
  repairMediaFocus,
} from './mediaScaleLogic.js';

const sources = [
  { id: 'a', path: '/素材/東京 夜景/Camera_A.MP4' },
  { id: 'b', path: '/stock/people/Caf\u00e9-interview.mov' },
  { id: 'c', path: '/stock/people/team_meeting.webm' },
];

describe('media filtering', () => {
  it('matches full paths case-insensitively without rewriting Japanese source data', () => {
    expect(filterMediaSources(sources, 'camera_a')).toEqual([sources[0]]);
    expect(filterMediaSources(sources, '東京 MP4')).toEqual([sources[0]]);
    expect(sources[0].path).toBe('/素材/東京 夜景/Camera_A.MP4');
  });

  it('normalizes composed/decomposed text and requires all search terms', () => {
    expect(filterMediaSources(sources, 'Cafe\u0301 PEOPLE')).toEqual([sources[1]]);
    expect(filterMediaSources(sources, 'people meeting')).toEqual([sources[2]]);
    expect(filterMediaSources(sources, 'people missing')).toEqual([]);
  });

  it('treats whitespace-only search as no filter', () => {
    expect(mediaSearchTerms('  \n ')).toEqual([]);
    expect(filterMediaSources(sources, '  ')).toEqual(sources);
  });
});

describe('media paging', () => {
  const many = Array.from({ length: 93 }, (_, i) => ({ id: `s${i + 1}`, path: `/mix/${i + 1}.mp4` }));

  it('renders forty cards by default instead of materializing the entire pool', () => {
    const page = mediaPage(many, '', MEDIA_PAGE_SIZE);
    expect(page.matched).toHaveLength(93);
    expect(page.visible).toHaveLength(40);
    expect(page.hiddenCount).toBe(53);
  });

  it('shows every result when a search is smaller than the current chunk', () => {
    const page = mediaPage(many, '/9', MEDIA_PAGE_SIZE);
    expect(page.matched.map((source) => source.id)).toEqual(['s9', 's90', 's91', 's92', 's93']);
    expect(page.visible).toEqual(page.matched);
    expect(page.hiddenCount).toBe(0);
  });

  it('supports explicit subsequent chunks and defends against invalid limits', () => {
    expect(mediaPage(many, '', 80).visible).toHaveLength(80);
    expect(mediaPage(many, '', Number.NaN).visible).toHaveLength(40);
  });
});

describe('media roving focus', () => {
  const visible = ['s1', 's2', 's3'];

  it('repairs a focus id removed by filtering to the first rendered card', () => {
    expect(repairMediaFocus(visible, 's90')).toBe('s1');
    expect(repairMediaFocus([], 's90')).toBeNull();
  });

  it('moves and clamps only within currently rendered cards', () => {
    expect(mediaFocusTarget(visible, 's2', 'ArrowDown')).toBe('s3');
    expect(mediaFocusTarget(visible, 's3', 'ArrowDown')).toBe('s3');
    expect(mediaFocusTarget(visible, 's2', 'ArrowUp')).toBe('s1');
    expect(mediaFocusTarget(visible, 's1', 'End')).toBe('s3');
    expect(mediaFocusTarget(visible, 's3', 'Home')).toBe('s1');
  });
});
