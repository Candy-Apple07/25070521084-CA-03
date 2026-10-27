// A 1200x630 result card people can post after a match. It carries the game's address and the repo,
// so every shared result is also an invitation.

import type { MatchState } from '../core/rules';
import type { Member } from '../net/protocol';

export const SITE_URL = 'https://baize-club.vercel.app';
export const REPO_URL = 'https://github.com/AtharvaLakhe/baize-club';

export async function makeShareCard(match: MatchState, players: [Member | undefined, Member | undefined]): Promise<Blob | null> {
  await document.fonts?.ready;
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 630;
  const ctx = c.getContext('2d')!;

  // Walnut background with a cloth panel.
  const bg = ctx.createLinearGradient(0, 0, 0, 630);
  bg.addColorStop(0, '#4b3020'); bg.addColorStop(1, '#24160d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 1200, 630);
  ctx.strokeStyle = 'rgba(201,165,92,0.8)'; ctx.lineWidth = 6;
  ctx.strokeRect(24, 24, 1152, 582);
  const cloth = ctx.createRadialGradient(600, 330, 40, 600, 330, 560);
  cloth.addColorStop(0, '#2f8a52'); cloth.addColorStop(1, '#174f2d');
  ctx.fillStyle = cloth; ctx.fillRect(60, 150, 1080, 330);

  ctx.fillStyle = '#efe6d2';
  ctx.font = '800 64px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Obsidian', 60, 112);
  ctx.fillStyle = '#c9a55c';
  ctx.font = '600 28px Inter, sans-serif';
  ctx.textAlign = 'right';
  const fmt = match.settings.bestOf > 1 ? `Best of ${match.settings.bestOf}` : 'Single frame';
  ctx.fillText(match.settings.game === 'pool8' ? `${fmt}, 8-ball pool` : `${fmt}, ${match.settings.reds} reds`, 1140, 108);

  const winner = match.winner ?? 0;
  const names = players.map((p, i) => p?.name ?? `Player ${i + 1}`);
  const faces = players.map((p) => p?.avatar ?? '🎱');
  ctx.textAlign = 'center';
  for (const seat of [0, 1] as const) {
    const x = seat === 0 ? 330 : 870;
    ctx.font = '72px serif';
    ctx.fillText(faces[seat], x, 250);
    ctx.fillStyle = '#efe6d2';
    ctx.font = '600 40px Inter, sans-serif';
    ctx.fillText(names[seat].slice(0, 16), x, 310);
    ctx.font = '700 120px Inter, sans-serif';
    ctx.fillStyle = seat === winner ? '#ecd28f' : 'rgba(239,230,210,0.75)';
    ctx.fillText(String(match.frames[seat]), x, 440);
    ctx.fillStyle = '#efe6d2';
  }
  ctx.font = '700 64px Inter, sans-serif';
  ctx.fillStyle = 'rgba(239,230,210,0.6)';
  ctx.fillText('frames', 600, 420);

  const hb = Math.max(match.stats[0].highBreak, match.stats[1].highBreak);
  const hbSeat = match.stats[0].highBreak >= match.stats[1].highBreak ? 0 : 1;
  ctx.fillStyle = '#efe6d2';
  ctx.font = '500 30px Inter, sans-serif';
  ctx.fillText(match.settings.game === 'pool8' ? `${names[winner]} wins at 8-ball.` : `${names[winner]} wins. Highest break ${hb} by ${names[hbSeat]}.`, 600, 535);
  ctx.fillStyle = '#c9a55c';
  ctx.font = '600 26px Inter, sans-serif';
  ctx.fillText(`Play your friends at baize-club.vercel.app  ·  github.com/AtharvaLakhe/baize-club`, 600, 580);

  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
}

export async function shareResult(match: MatchState, players: [Member | undefined, Member | undefined]) {
  const blob = await makeShareCard(match, players);
  if (!blob) return;
  const file = new File([blob], 'obsidian-result.png', { type: 'image/png' });
  const text = `${match.settings.game === 'pool8' ? '8-ball pool' : 'Snooker'} at Obsidian: ${players[0]?.name ?? 'P1'} ${match.frames[0]}-${match.frames[1]} ${players[1]?.name ?? 'P2'}. Play your friends: ${SITE_URL}`;
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text, title: 'Obsidian' }); return; } catch { /* cancelled */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'obsidian-result.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
