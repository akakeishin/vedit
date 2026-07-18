import { describe, expect, it } from 'vitest';
import { buildAiRequestEnvelope } from './aiRequestLogic.js';

describe('buildAiRequestEnvelope', () => {
  it('binds a copied AI request to its absolute project and displayed revision', () => {
    const text = buildAiRequestEnvelope({
      projectDir: '/tmp/日本語 project/a',
      revision: 42,
      request: 'BGMを整えて',
    });
    expect(text).toContain('対象のveditプロジェクト: /tmp/日本語 project/a');
    expect(text).toContain('画面表示時の版: 42');
    expect(text).toContain('依頼: BGMを整えて');
    expect(text).toContain('project.jsonを読み直して最新の版を確認');
    expect(text).toContain('対象パスが一致しない場合は編集せず停止');
    expect(text).toContain('文字起こしと波形が一致した内側の無音');
    expect(text).toContain('根拠不足または根拠衝突');
    expect(text).toContain('冒頭・末尾の間');
    expect(text).toContain('短い断片の巻き込み');
    expect(text).toContain('前後の文脈、理由、得失と2択');
    expect(text).toContain('保護済みintent、不正区間、現在版に効果がない候補、判断済み候補は質問にせず');
  });

  it('does not invent an identity when the project has not finished loading', () => {
    const text = buildAiRequestEnvelope({ projectDir: null, revision: null, request: '確認して' });
    expect(text).toContain('対象のveditプロジェクト: (未確認)');
    expect(text).toContain('画面表示時の版: (未確認)');
  });
});
