// The browser builds its own calldata by hand (no library on the page). If a selector were wrong the wallet would
// send a real transaction to the wrong function, so every one is checked against the contract's actual ABI.
import { describe, expect, it } from 'vitest';
import { encodeEventTopics, parseAbi, toFunctionSelector } from 'viem';
import { formatAmount, parseAmount, ROOM_CREATED, SEL } from '../../web/src/net/stake.ts';

const abi = parseAbi([
  'function createRoom(uint8 maxPlayers, uint96 stake, uint40 expirySecs) returns (uint256)',
  'function joinRoom(uint256)', 'function startGame(uint256)', 'function leaveRoom(uint256)', 'function cancelRoom(uint256)',
  'function getRoom(uint256) view returns (address host, uint8 status, uint8 maxPlayers, uint96 stake, uint96 pot, uint40 createdAt, uint40 expiresAt, uint40 startedAt, address[] players)',
  'function approve(address,uint256) returns (bool)', 'function pause()', 'function unpause()', 'function withdrawAll(address)', 'function allowance(address,address) view returns (uint256)',
  'event RoomCreated(uint256 indexed roomId, address indexed host, uint8 maxPlayers, uint96 stake, uint40 expiresAt)',
]);

describe('the page\'s hand-made calldata', () => {
  it('uses the real function selectors', () => {
    for (const [name, sel] of Object.entries(SEL)) expect(sel, name).toBe(toFunctionSelector(abi.find((a): a is Extract<typeof a, { type: 'function' }> => a.type === 'function' && a.name === name)!));
  });
  it('looks for the real RoomCreated topic', () => {
    expect(ROOM_CREATED).toBe(encodeEventTopics({ abi, eventName: 'RoomCreated' })[0]);
  });
  it('turns what is typed into exact token units, and refuses nonsense', () => {
    expect(parseAmount('0.05')).toBe(50000000000000000n);
    expect(parseAmount('2')).toBe(2n * 10n ** 18n);
    expect(formatAmount(50000000000000000n)).toBe('0.05');
    expect(formatAmount(2n * 10n ** 18n)).toBe('2');
    for (const bad of ['', '-1', '0', '0.0', 'abc', '1e3', '1.1234567890123456789', '1,5']) expect(() => parseAmount(bad), bad).toThrow();
    // USDT has 6 decimals: 0.05 is 50,000 units, and a seventh decimal is refused rather than rounded away
    expect(parseAmount('0.05', 6)).toBe(50000n);
    expect(parseAmount('2', 6)).toBe(2000000n);
    expect(() => parseAmount('0.0000001', 6)).toThrow();
    expect(formatAmount(50000n, 6)).toBe('0.05');
    expect(formatAmount(1234567n, 6)).toBe('1.234567');
  });
});
