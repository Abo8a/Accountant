import { describe, expect, it } from 'vitest';
import type { PipelinePassportField } from '@passport/contracts';
import { formatPlanUntil, liveShell, openGapsCount, projectTitle, userBadge } from './cabinetView';
import { totalsFromResponse } from '../../features/onboarding/Generating';
import { completedFromState } from '../../features/passport/Result';
import type { CabinetState } from '../api/cabinet';

const field = (section_id: number, field_key: string, value: string | null, review_status = 'ai_generated', claims: PipelinePassportField['claims'] = []): PipelinePassportField => ({
  section_id,
  field_key,
  value,
  review_status,
  claims,
});

const claim = (claim_type: 'fact' | 'plan' | 'hypothesis' | 'client_statement', source_id: string | null = null) => ({
  claim_text: 'текст утверждения длиной от 15',
  claim_type,
  claim_kind: null,
  source_id,
  source_locator: null,
  span_start: 0,
  span_end: 10,
  order_index: 1,
  verification_status: 'unverified' as const,
});

const STATE: CabinetState = {
  plan_id: 'pro',
  plan_expires_at: '2026-12-01T10:00:00.000Z',
  files_used: 1,
  files_limit: 10,
  founder: { full_name: 'Корина Нина Сергеевна' },
  study_certificate: null,
  project_status: 'generating',
  passport: [
    field(4, 'product_summary', 'Создание системы контроля сварных швов по фото, для малых заводов.'),
    field(4, 'tech_challenge', null),
    field(2, 'team_members', null),
    field(3, 'problem_description', 'Брак швов 8–12%.', 'needs_review'),
  ],
  block_audits: [],
  budget_audit: null,
  result: null,
};

describe('шапка кабинета в живом режиме', () => {
  it('пробелы: пустые обязательные поля и поля с замечанием; необязательный вызов не считается', () => {
    expect(openGapsCount(STATE.passport)).toBe(2);
  });

  it('название проекта — первая фраза сути продукта, тариф и пользователь — из профиля', () => {
    expect(projectTitle(STATE.passport)).toBe('Создание системы контроля сварных швов…');
    expect(projectTitle([])).toBe('Мой проект');
    expect(userBadge('Корина Нина Сергеевна')).toEqual({ name: 'Корина Нина', initials: 'КН' });
    expect(formatPlanUntil('2026-12-01T10:00:00.000Z')).toBe('до 1 декабря 2026');
    expect(formatPlanUntil(null)).toBe('');
    const shell = liveShell(STATE);
    expect(shell.plan).toMatchObject({ name: 'Профессиональный', files: 'Файлы: 1 из 10', fillPercent: 10 });
    expect(shell.project.name).not.toBe('Monetrix');
  });
});

describe('итог сборки и итог проверки из данных пользователя', () => {
  it('сборка: заполненные блоки, пробелы и утверждения по трём цветам — из ответа, а не из макета', () => {
    const totals = totalsFromResponse({
      status: 'NEED_USER_INPUT',
      passport: [field(3, 'problem_description', 'x', 'ai_generated', [claim('fact', 'src'), claim('client_statement'), claim('plan'), claim('hypothesis')])],
      block_audits: [{ section_id: 3, status: 'approved', remark: null, how_to_fix: null, failed_fields: [] }],
    });
    expect(totals.claims).toEqual({ doc: 1, nodoc: 1, plan: 2 });
    expect(totals.approved).toBe(1);
    expect(totals.filled).toBe(0);
  });

  it('итог проверки из сохранённого результата: предупреждение о справке попадает в список дел', () => {
    const completed = completedFromState({
      ...STATE,
      result: {
        eligibility_status: 'NEEDS_CLARIFICATION',
        summary: 'Итог',
        checklist: ['Загрузить в профиль справку об обучении'],
        warnings: ['Справка об обучении в вузе не загружена'],
        calculated_at: '2026-11-19T00:00:00Z',
      },
    });
    expect(completed).toMatchObject({ status: 'COMPLETED', eligibility_status: 'NEEDS_CLARIFICATION', export_ready: false });
    expect(completedFromState(STATE)).toBeUndefined();
  });
});
