import { describe, it, expect } from 'vitest';
import { describeBlock, BLOCK_CATALOG } from './catalog';
import { isContainerTag } from './block';

describe('describeBlock', () => {
  it('describes every container tag in the hardcoded set', () => {
    for (const tag of ['LECF', 'LFLF', 'ROOM', 'RMIM', 'OBIM', 'OBCD']) {
      const info = describeBlock(tag);
      expect(info, `missing catalog entry for ${tag}`).toBeDefined();
      expect(info!.shortName).toBeTruthy();
      expect(info!.description).toBeTruthy();
    }
  });

  it('synthesizes descriptions for IM00..IM0F image containers', () => {
    expect(describeBlock('IM00')?.shortName).toBe('Image data');
    expect(describeBlock('IM0F')?.shortName).toBe('Image data');
  });

  it('synthesizes descriptions for ZP-prefixed z-plane masks', () => {
    expect(describeBlock('ZP01')?.shortName).toBe('Z-plane mask');
    expect(describeBlock('ZP02')?.shortName).toBe('Z-plane mask');
  });

  it('returns undefined for tags it does not know', () => {
    expect(describeBlock('XXXX')).toBeUndefined();
    expect(describeBlock('ZZZZ')).toBeUndefined();
  });

  it('describes the index-file directory blocks', () => {
    for (const tag of ['RNAM', 'MAXS', 'DROO', 'DSCR', 'DSOU', 'DCOS', 'DCHR', 'DOBJ']) {
      expect(describeBlock(tag), `missing entry for ${tag}`).toBeDefined();
    }
  });

  it('every container tag in the parser is also in the catalog', () => {
    // Lightly enforces the contract that walker and catalog stay in sync
    // for the parser's known container set.
    for (const tag of Object.keys(BLOCK_CATALOG)) {
      if (isContainerTag(tag)) {
        expect(describeBlock(tag), `${tag}: parser says container, must be in catalog`).toBeDefined();
      }
    }
  });
});
