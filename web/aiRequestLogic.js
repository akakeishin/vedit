/**
 * Build a self-contained handoff for a fresh Codex / Claude Code session.
 * A copied request without project identity can silently target the repo cwd
 * or whichever project a daemon happens to have open; revision is included as
 * context, but the agent is explicitly told to re-read current state before
 * mutating rather than treating the displayed value as a lock forever.
 */
export function buildAiRequestEnvelope({ projectDir, revision, request }) {
  const dir = typeof projectDir === 'string' && projectDir ? projectDir : '(未確認)';
  const rev = revision !== null && revision !== undefined && revision !== '' && Number.isFinite(Number(revision))
    ? String(revision)
    : '(未確認)';
  return [
    `対象のveditプロジェクト: ${dir}`,
    `画面表示時の版: ${rev}`,
    `依頼: ${String(request ?? '').trim()}`,
    '',
    '実行前に対象パスのproject.jsonを読み直して最新の版を確認してください。対象パスが一致しない場合は編集せず停止してください。',
    '低リスク・可逆で、文字起こしと波形が一致した内側の無音など独立した根拠があり、保護区間外・実効果あり・短い断片を巻き込まない作業は自律的に進めてください。',
    '質問する例外は、意味や好みで結果が変わる箇所、フィラー、根拠不足または根拠衝突、冒頭・末尾の間、短い断片の巻き込み、大きな構成変更です。前後の文脈、理由、得失と2択を示してください。',
    '保護済みintent、不正区間、現在版に効果がない候補、判断済み候補は質問にせず、診断として除外してください。',
  ].join('\n');
}
