import {readFile} from 'node:fs/promises';

export const replayExtension = /\.ttrm?$/i;

const hasFrames = replay => Number.isFinite(replay?.frames) && replay.frames > 0 && Array.isArray(replay.events);
export const roundFrameCount = round => Math.max(...round.map(player => player.replay.frames));

export function validateRoundSelection(selection, roundCount) {
  if (!Array.isArray(selection) || !selection.length || selection.length > roundCount ||
      selection.some(round => !Number.isInteger(round) || round < 1 || round > roundCount) ||
      new Set(selection).size !== selection.length) {
    throw Error(`Choose one or more distinct rounds from 1 to ${roundCount}`);
  }
  return [...selection].sort((a, b) => a - b);
}

export async function readReplay(file, roundList) {
  if (!replayExtension.test(file)) throw Error('Choose a .ttr or .ttrm replay file');
  const replay = JSON.parse(await readFile(file, 'utf8'));
  if (/\.ttr$/i.test(file)) {
    if (roundList !== undefined) throw Error('Round selection requires a multiplayer .ttrm replay');
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
  if (roundList === undefined) return {replay, singleplayer: false, rounds};
  const roundNumbers = validateRoundSelection(roundList.split(',').map(Number), rounds.length);
  if (roundNumbers.length === rounds.length) return {replay, singleplayer: false, rounds};

  // Run the native match player on the chosen rounds in their original order.
  // Keep the original numbering for filenames and the video overlay.
  const chosen = roundNumbers.map(round => rounds[round - 1]);
  replay.replay.rounds = chosen;
  return {replay, singleplayer: false, rounds: chosen, roundNumbers, sourceRoundCount: rounds.length};
}
