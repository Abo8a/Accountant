// Анкеты полей из текста, который собрал ИИ (бриф, документы): выбор «да/нет», строки таблицы, отметки.
// Без этого после загрузки документа поле с анкетой открывалось пустой анкетой, хотя ответ в тексте уже есть.
// Один вызов модели на все такие поля; ответ проверяется (sanitizeFieldForm) — варианты только из списка.
import { FIELD_FORM_SHAPES, sanitizeFieldForm } from '@passport/contracts';
import { callLlm, fillFormsSchema } from '../llm/schemas';
import { wrapUntrustedData } from '../promptGuard';
import { FIELD_TITLES } from './exportLabels';
import type { PipelineDeps } from './deps';

const TEAM_KEY = '2/team_members';

function teamNames(form: unknown): string[] {
  const rows = (form as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => (typeof r?.name === 'string' ? r.name.trim() : '')).filter(Boolean);
}

/**
 * Раскладывает текст полей keys («секция/поле») по их анкетам и сохраняет форму рядом с текстом.
 * Поля без анкеты, пустые и с уже сохранённой анкетой пропускаются. Сбой модели не ломает сборку паспорта:
 * анкета просто остаётся пустой, как раньше.
 */
export async function fillFieldForms(deps: PipelineDeps, projectId: string, keys: Iterable<string>): Promise<void> {
  const wanted = [...new Set(keys)].filter((k) => FIELD_FORM_SHAPES[k]);
  if (wanted.length === 0) return;
  const records = await deps.store.getRecords(projectId);
  const forms = await deps.store.getFieldForms(projectId);
  const fields = wanted
    .map((key) => {
      const [sid, fieldKey] = key.split('/');
      const value = records.find((r) => String(r.section_id) === sid && r.field_key === fieldKey)?.value?.trim();
      return value && !forms[key] ? { key, section_id: Number(sid), field_key: fieldKey!, value } : null;
    })
    .filter((f): f is { key: string; section_id: number; field_key: string; value: string } => f !== null);
  if (fields.length === 0) return;

  try {
    const out = await callLlm(
      deps.llm,
      'fill_forms',
      {
        team: teamNames(forms[TEAM_KEY]),
        fields: fields.map((f) => ({
          section_id: f.section_id,
          field_key: f.field_key,
          title: FIELD_TITLES[f.field_key] ?? f.field_key,
          text: wrapUntrustedData(`field:${f.key}`, f.value),
          shape: FIELD_FORM_SHAPES[f.key],
        })),
      },
      fillFormsSchema,
    );
    // Команду сохраняем первой: из неё берутся имена для отметок «Авторы из команды».
    const byKey = new Map(out.forms.map((f) => [`${f.section_id}/${f.field_key}`, f.data]));
    let team = teamNames(forms[TEAM_KEY]);
    const ordered = [...fields].sort((a, b) => (a.key === TEAM_KEY ? -1 : b.key === TEAM_KEY ? 1 : 0));
    let saved = 0;
    for (const f of ordered) {
      const data = sanitizeFieldForm(FIELD_FORM_SHAPES[f.key]!, byKey.get(f.key), team);
      if (!data) continue;
      if (await deps.store.setFieldForm(projectId, f.section_id, f.field_key, data)) saved++;
      if (f.key === TEAM_KEY) team = teamNames(data);
    }
    deps.logger.info(`[fill_forms] анкет заполнено: ${saved} из ${fields.length}`);
  } catch (err) {
    deps.logger.warn('[fill_forms] анкеты не заполнены, поля остаются текстом:', err);
  }
}
