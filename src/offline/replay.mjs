import {readFile} from 'node:fs/promises';

export const replayExtension = /\.ttrm?$/i;

const hasFrames = replay => Number.isFinite(replay?.frames) && replay.frames > 0 && Array.isArray(replay.events);
export const roundFrameCount = round => Math.max(...round.map(player => player.replay.frames));

export async function readReplay(file) {
  if (!replayExtension.test(file)) throw Error('Choose a .ttr or .ttrm replay file');
  const replay = JSON.parse(await readFile(file, 'utf8'));
  if (/\.ttr$/i.test(file)) {
    // Older exports carry the same frame data under data and a single user.
    // Leave the replay itself intact for the native client's format upgrade.
    const legacy = replay?.version == null && !Array.isArray(replay?.users);
    const game = legacy ? replay?.data ?? replay?.replay : replay.replay;
    const users = legacy && !replay?.ismulti && replay?.endcontext ? [replay.user] : replay?.users;
    if (!hasFrames(game) || !Array.isArray(users) || users.length !== 1 || typeof users[0]?.username !== 'string') {
      throw Error('Expected a complete single-player replay');
    }
    if (!legacy && replay.version !== 0 && replay.version !== 1) throw Error('Unsupported single-player replay format version');
    return {replay, singleplayer: true, rounds: [[{replay: game}]]};
  }
  const rounds = replay?.replay?.rounds;
  if (!Array.isArray(rounds) || !rounds.length || rounds.some(round => !Array.isArray(round) || round.length !== 2 || round.some(player => !hasFrames(player?.replay)))) {
    throw Error('Expected complete two-player multiplayer replay data');
  }
  return {replay, singleplayer: false, rounds};
}
